// "Quote to Google Sheet" — standalone Cloudflare Worker backend.
// Ported from the workspace "Quote to Google Sheet" app: Salesforce CPQ (SBQQ) quote
// search + template-driven export into a Google Sheet tab.
// Auth: OAuth (Salesforce + Google) with sessions stored in the SESSIONS KV namespace.

const SF_API_VER = "v61.0";
const SHEETS_V4 = "https://sheets.googleapis.com/v4/spreadsheets/";

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function escSOQL(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function colLetter(idx) { let s = "", n = idx; while (n > 0) { let m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }
function randomHex(len) { let b = new Uint8Array(len); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); }

// Salesforce uses round-half-to-even (banker's) from the SFDC quote editor observations?
// Empirically we found SFDC per-line values do NOT map one-to-one to any single rounding
// rule (they are stored by the CPQ calculation engine). We keep half-even as the best
// average match for computed lines (verified against Q-720368 / Q-725916 / Q-725868).
function round2(n) {
  let x = n * 100;
  let base = Math.floor(x);
  let frac = x - base;
  let r;
  if (Math.abs(frac - 0.5) < 1e-6) r = (base % 2 === 0) ? base : base + 1;
  else r = Math.round(x);
  return r / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions (KV)
// ─────────────────────────────────────────────────────────────────────────────

async function getSession(env, request) {
  let m = /(?:^|;\s*)sid=([0-9a-f]{32})/.exec(request.headers.get("Cookie") || "");
  if (!m) return null;
  let raw = await env.SESSIONS.get("sess:" + m[1]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) { return null; }
}
async function saveSession(env, sid, data, ttlSeconds = 60 * 60 * 24 * 30) {
  await env.SESSIONS.put("sess:" + sid, JSON.stringify(data), { expirationTtl: ttlSeconds });
}
function setCookie(env, sid, request) {
  let https = new URL(request.url).protocol === "https:";
  return "sid=" + sid + "; Path=/; HttpOnly; SameSite=Lax" + (https ? "; Secure" : "") + "; Max-Age=" + (60 * 60 * 24 * 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth flows
// ─────────────────────────────────────────────────────────────────────────────

function callbackUrl(request, kind) {
  let origin = new URL(request.url).origin;
  return origin + "/auth/" + kind + "/callback";
}

async function oauthStart(kind, request, env) {
  let state = randomHex(16);
  let returnTo = request.referer || new URL(request.url).origin + "/";
  // Which page to return to after consent (default: app root).
  try { returnTo = new URL(request.url).searchParams.get("return") || returnTo; } catch (e) { }
  await env.SESSIONS.put("oauth:" + state, JSON.stringify({ kind, returnTo }), { expirationTtl: 600 });
  let auth;
  if (kind === "sf") {
    let u = new URL("https://login.salesforce.com/services/oauth2/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", env.SF_CLIENT_ID);
    u.searchParams.set("redirect_uri", callbackUrl(request, "sf"));
    u.searchParams.set("scope", "api refresh_token");
    u.searchParams.set("state", state);
    auth = u.toString();
  } else {
    let u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    u.searchParams.set("redirect_uri", callbackUrl(request, "google"));
    u.searchParams.set("scope", "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email openid");
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    auth = u.toString();
  }
  return Response.redirect(auth, 302);
}

async function oauthCallback(kind, request, env) {
  let url = new URL(request.url);
  let code = url.searchParams.get("code");
  let state = url.searchParams.get("state");
  let st = state ? await env.SESSIONS.get("oauth:" + state) : null;
  if (!code || !st) return new Response("Invalid OAuth state — try connecting again.", { status: 400 });
  let meta = JSON.parse(st);
  await env.SESSIONS.delete("oauth:" + state);

  let tokenUrl = kind === "sf"
    ? "https://login.salesforce.com/services/oauth2/token"
    : "https://oauth2.googleapis.com/token";
  let body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(request, kind),
    client_id: env.SF_CLIENT_ID && kind === "sf" ? env.SF_CLIENT_ID : env.GOOGLE_CLIENT_ID,
    client_secret: kind === "sf" ? env.SF_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET,
  });
  let tr = await fetch(tokenUrl, { method: "POST", body });
  if (!tr.ok) return new Response("OAuth token exchange failed: " + (await tr.text()).slice(0, 300), { status: 502 });
  let tok = await tr.json();
  if (kind === "sf") {
    let me = await sfFullFetch(env, null, { instanceUrl: tok.instance_url, accessToken: tok.access_token, refreshToken: tok.refresh_token }, "/sobjects/Quote/describe")
      .catch(() => null);
    let existing = await getSession(env, request);
    let data = Object.assign(existing || {}, {
      sf: { instanceUrl: tok.instance_url, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + (me ? 0 : 0) },
      sfExpTokenAt: null,
    });
    let sid = randomHex(16);
    await saveSession(env, sid, data);
    return new Response(null, { status: 302, headers: { Location: meta.returnTo || "/", "Set-Cookie": setCookie(env, sid, request) } });
  } else {
    let existing = await getSession(env, request);
    let data = Object.assign(existing || {}, {
      google: { accessToken: tok.access_token, refreshToken: tok.refresh_token || (existing && existing.google ? existing.google.refresh_token : null), expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 },
    });
    let sid = randomHex(16);
    await saveSession(env, sid, data);
    return new Response(null, { status: 302, headers: { Location: meta.returnTo || "/", "Set-Cookie": setCookie(env, sid, request) } });
  }
}

async function sfFullFetch(env, session, tokens, path) {
  let inst = tokens.instanceUrl;
  let url = inst + "/services/data/" + SF_API_VER + path;
  let r = await fetch(url, { headers: { Authorization: "Bearer " + tokens.accessToken } });
  if (r.status === 401 && tokens.refreshToken) {
    let rx = await fetch("https://login.salesforce.com/services/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: env.SF_CLIENT_ID,
        client_secret: env.SF_CLIENT_SECRET,
      }),
    });
    if (!rx.ok) throw new Error("Salesforce refresh failed: " + (await rx.text()).slice(0, 200));
    let nt = await rx.json();
    tokens.accessToken = nt.access_token;
    if (session) {
      session.sf.accessToken = nt.access_token;
      session.sf.instanceUrl = nt.instance_url || session.sf.instanceUrl;
      await saveSession(env, session.__sid, session);
    }
    inst = nt.instance_url || inst;
    url = inst + "/services/data/" + SF_API_VER + path;
    r = await fetch(url, { headers: { Authorization: "Bearer " + nt.accessToken } });
  }
  if (!r.ok) {
    let t = await r.text();
    throw new Error("Salesforce " + r.status + ": " + t.slice(0, 400));
  }
  return r.json();
}
async function sfQuery(env, session, soql) {
  return sfFullFetch(env, session, session.sf, "/query?q=" + encodeURIComponent(soql));
}

async function googleFullFetch(env, session, url, init) {
  let now = Date.now();
  let headers = Object.assign({ Authorization: "Bearer " + session.google.accessToken }, init && init.headers);
  let r = await fetch(url, Object.assign({}, init, { headers }));
  if (r.status === 401 && session.google.refreshToken) {
    let rx = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.google.refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      }),
    });
    if (!rx.ok) throw new Error("Google token refresh failed: " + (await rx.text()).slice(0, 200));
    let nt = await rx.json();
    session.google.accessToken = nt.access_token;
    session.google.expiresAt = now + (nt.expires_in || 3600) * 1000;
    await saveSession(env, session.__sid, session);
    r = await fetch(url, Object.assign({}, init, { headers: Object.assign({}, headers, { Authorization: "Bearer " + nt.accessToken }) }));
  }
  if (!r.ok) {
    let t = await r.text();
    throw new Error("Google Sheets " + r.status + ": " + t.slice(0, 300));
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain logic — ported from the workspace app (SF rules identical)
// ─────────────────────────────────────────────────────────────────────────────

const QL_FIELDS = "Id, Name, SBQQ__Quote__c, SBQQ__Group__c, SBQQ__ProductName__c, SBQQ__ProductCode__c, SBQQ__Quantity__c, SBQQ__ListTotal__c, SBQQ__RegularTotal__c, SBQQ__CustomerTotal__c, SBQQ__NetTotal__c, SBQQ__ListPrice__c, SBQQ__RegularPrice__c, SBQQ__CustomerPrice__c, SBQQ__NetPrice__c, SBQQ__SpecialPrice__c, Existing_MRR__c, Regular_Price_Monthly__c, Overage_Price__c, SBQQ__Number__c, SBQQ__RequiredBy__c, SBQQ__Component__c, Line_Position__c, SBQQ__Description__c";

function isExcessLine(l) {
  return /-ME00$|-MU00$/i.test(l.SBQQ__ProductCode__c || "") || / EXCESS PRICE$/i.test(l.SBQQ__ProductName__c || "");
}
function isRollupLine(l) {
  if (/-CONT-/i.test(l.SBQQ__ProductCode__c || "")) return true;
  let name = l.SBQQ__ProductName__c || "";
  return / MONTHLY CAP$/i.test(name) && !/\bPER\b/i.test(name) && !Number(l.SBQQ__NetTotal__c);
}
function isMainLine(l) { return !isExcessLine(l) && !isRollupLine(l); }

// Universal geo merge: any SKU "... (<region>) Monthly Cap" is internal detail —
// fold price into the matching "… Global …" sibling. Verified against Cloudflare quote data.
const GEO_REGION_RE = new RegExp(" \\((Asia|AUS/NZ|China|Europe|India|Korea|Middle East & Africa|North America|South America|Taiwan)\\) Monthly Cap$", "i");
function mergeRegionalRecords(lines) {
  let regionals = lines.filter(l => !isExcessLine(l) && GEO_REGION_RE.test(l.SBQQ__ProductName__c || ""));
  if (!regionals.length) return lines;
  let out = lines.filter(l => !regionals.includes(l));
  for (let reg of regionals) {
    let base = String(reg.SBQQ__ProductName__c || "").replace(GEO_REGION_RE, "");
    let candidates = [base + " (Global) Monthly Cap", base + " Global Monthly Cap"];
    let target = out.find(l => !isExcessLine(l) && candidates.some(c => c.toLowerCase() === String(l.SBQQ__ProductName__c || "").toLowerCase()));
    if (target) {
      target.SBQQ__NetTotal__c = (Number(target.SBQQ__NetTotal__c) || 0) + (Number(reg.SBQQ__NetTotal__c) || 0);
    } else {
      out.push(reg);
    }
  }
  out.sort((a, b) => (Number(a.SBQQ__Number__c) || 0) - (Number(b.SBQQ__Number__c) || 0));
  return out;
}

const TOTAL_SUM_FIELDS = { ListTotal: "SBQQ__ListTotal__c", RegularTotal: "SBQQ__RegularTotal__c", CustomerTotal: "SBQQ__CustomerTotal__c", NetTotal: "SBQQ__NetTotal__c" };

async function fetchBundle(env, session, quoteId, grid) {
  // 1) Quote
  let qR = await sfQuery(env, session, "SELECT Id, Name, Net_Amount_Discountable__c, SBQQ__Opportunity2__c, Discretionary_Discount_Applied__c, Opportunity_Type__c FROM SBQQ__Quote__c WHERE Id = '" + escSOQL(quoteId) + "' LIMIT 1");
  let quote = qR.records[0];
  if (!quote) throw new Error("Quote not found.");

  // 2) Opportunity (for contract months + names)
  let opp = null, account = null;
  if (quote.SBQQ__Opportunity2__c) {
    let oR = await sfQuery(env, session, "SELECT Id, Name, Contract_Months__c, SBQQ__PrimaryQuote__c, Account.Name FROM Opportunity WHERE Id = '" + escSOQL(quote.SBQQ__Opportunity2__c) + "' LIMIT 1");
    if (oR.records.length) { opp = oR.records[0]; if (opp.Account) account = { Name: opp.Account.Name }; }
  }

  // 3) Lines + groups
  let lRes = await sfQuery(env, session, "SELECT " + QL_FIELDS + " FROM SBQQ__QuoteLine__c WHERE SBQQ__Quote__c = '" + escSOQL(quoteId) + "' ORDER BY SBQQ__Number__c ASC");
  let gR = await sfQuery(env, session, "SELECT Id, Name FROM SBQQ__QuoteLineGroup__c WHERE SBQQ__Quote__c = '" + escSOQL(quoteId) + "'");
  let groups = gR.records.map(g => ({ id: g.Id, Name: g.Name }));
  let groupedIds = new Set(groups.map(g => g.id));
  let hasUngrouped = lRes.records.some(l => !l.SBQQ__Group__c);
  if (hasUngrouped) groups.push({ id: null, Name: "Other" });

  // 4) Fold regional per-region SKUs into Global.
  let lineRecords = mergeRegionalRecords(lRes.records);

  // 5) Monthly MRR: annualized ("Monthly Cap" = annual price) ÷ 12, half-even.
  const MONTHS = 12;
  for (let l of lineRecords) l.MRRTotal = round2((Number(l.SBQQ__NetTotal__c) || 0) / MONTHS);

  // On-demand (excess) SKUs: ME00 codes / "Excess Price" names, qty > 0, dedupe by name.
  let seen = new Set();
  let excess = lineRecords
    .filter(l => isExcessLine(l) && Number(l.SBQQ__Quantity__c) > 0)
    .filter(l => { let k = (l.SBQQ__ProductName__c || l.SBQQ__ProductCode__c || l.Id).toUpperCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  for (let l of excess) {
    let ov = Number(l.Overage_Price__c), qty = Number(l.SBQQ__Quantity__c);
    l.ExcessUnitPrice = Number.isFinite(ov) ? (qty === 1 ? ov : (qty > 0 ? Math.round((ov / qty) * 100000000) / 100000000 : ov)) : null;
  }

  // Quote monthly total: SFDC's MRR column = quote-level Net Amount when consistent,
  // else Σ per-line MRR when usage SKUs (e.g. R2) are excluded from the Net Amount.
  let linesMain = lineRecords.filter(isMainLine);
  let netSum = linesMain.reduce((s, l) => s + (Number(l.SBQQ__NetTotal__c) || 0), 0);
  let disc = Number(quote.Net_Amount_Discountable__c) || 0;
  if (Math.abs(netSum - disc) < 0.02) quote.NetAmountMonthly = round2(round2(disc) / MONTHS);
  else quote.NetAmountMonthly = round2(linesMain.reduce((s, l) => s + l.MRRTotal, 0));

  let totals = { LineCount: linesMain.length };
  for (let [alias, f] of Object.entries(TOTAL_SUM_FIELDS)) totals[alias] = linesMain.reduce((s, l) => s + (Number(l[f]) || 0), 0);

  return { Quote: quote, Opportunity: opp, Account: account, lines: lineRecords, groups, totals, excess };
}

// ── Template engine (CSV with {{Placeholders}} — identical syntax to workshop) ──

const TEMPLATE_OBJECTS = ["Quote", "Opportunity", "Account", "Group", "LineItem", "Totals", "QuoteLineGroup"];

function parseCsv(text) {
  let rows = [], row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  if (!rows.length) return [];
  let ncols = Math.max(...rows.map(r => r.length));
  return rows.map(r => { while (r.length < ncols) r.push(""); return r; });
}

function valueFor(source, field, type) {
  if (source == null || field === "") return null;
  let v = source[field];
  if (v == null || v === "") return null;
  if (type === "int" || type === "double" || type === "currency" || type === "percent") {
    let n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

function substitute(cell, bundle) {
  return String(cell).replace(/\{\{\s*[^}]+\}\}/g, (m) => {
    let inner = m.slice(2, -2).trim();
    let dot = inner.indexOf(".");
    if (dot < 0) return "";
    let obj = inner.slice(0, dot).trim(), field = inner.slice(dot + 1).trim();
    let v;
    switch (obj) {
      case "Quote": v = valueFor(bundle.Quote, field, null); break;
      case "Opportunity": v = valueFor(bundle.Opportunity, field, null); break;
      case "Account": v = valueFor(bundle.Account, field, null); break;
      case "Group": v = valueFor(bundle.currentGroup, field, null); break;
      case "LineItem": {
        let src = bundle.currentLine;
        let forceType = (field === "MRRTotal" || field === "ExcessUnitPrice") ? "double" : null;
        v = valueFor(src, field, forceType);
        if (field === "RowNumber") v = bundle.currentLineIndex != null ? bundle.currentLineIndex + 1 : null;
        break;
      }
      case "Totals": v = valueFor(bundle.totals, field, null); break;
      default: v = null;
    }
    return v == null ? "" : String(v);
  });
}

const LINE_PRICE_RE = /\{\{\s*LineItem\.(MRRTotal|Existing_MRR__c|Regular_Price_Monthly__c|SBQQ__NetTotal__c|SBQQ__CustomerTotal__c|SBQQ__ListTotal__c|SBQQ__RegularTotal__c|SBQQ__NetPrice__c|SBQQ__RegularPrice__c|SBQQ__CustomerPrice__c|SBQQ__ListPrice__c|Overage_Price__c)\s*\}\}/i;

function buildFilledGrid(templateGrid, bundle, mode) {
  let summary = mode === "summary";
  let linesMain = bundle.lines.filter(isMainLine);
  let rows = [], styles = [];
  let pushRow = (cells, style) => { rows.push(cells); styles.push(style || null); };
  let mapRow = (row, inner) => row.map((c, ci) => {
    let cc = String(ci === 0 ? String(c).replace(/\{\{@(header|bold)\}\}/i, "") : c);
    if (summary && inner.currentLine && LINE_PRICE_RE.test(cc)) return null;
    return substitute(cc, inner);
  });
  let i = 0;
  while (i < templateGrid.length) {
    let row = templateGrid[i];
    let marker = String(row[0] || "").trim().toLowerCase();
    if (marker.startsWith("{{@header}}")) { pushRow(mapRow(row, bundle), "header"); i++; continue; }
    if (marker.startsWith("{{@bold}}")) { pushRow(mapRow(row, bundle), "bold"); i++; continue; }
    if (marker === "{{#groups}}") {
      let block = [], j = i + 1;
      while (j < templateGrid.length && !String(templateGrid[j][0] || "").trim().toLowerCase().startsWith("{{/")) block.push(templateGrid[j++]);
      for (let group of bundle.groups) {
        let groupLines = linesMain.filter(l => (l.SBQQ__Group__c || null) === group.id);
        if (!groupLines.length) continue;
        for (let brow of block) {
          let bMarker = String(brow[0] || "").trim().toLowerCase();
          let bStyle = bMarker.startsWith("{{@header}}") ? "header" : bMarker.startsWith("{{@bold}}") ? "bold" : null;
          if (brow.some(c => /\{\{\s*LineItem\./.test(String(c)))) {
            groupLines.forEach((line, li) => pushRow(mapRow(brow, { ...bundle, currentLine: line, currentLineIndex: li, currentGroup: group }), bStyle));
          } else {
            let isGroupHeader = brow.some(c => /\{\{\s*Group\./.test(String(c)));
            pushRow(mapRow(brow, { ...bundle, currentGroup: group }), bStyle || (isGroupHeader ? "header" : null));
          }
        }
      }
      i = j + 1; continue;
    }
    if (marker === "{{#excess}}") {
      let block = [], j = i + 1;
      while (j < templateGrid.length && !String(templateGrid[j][0] || "").trim().toLowerCase().startsWith("{{/")) block.push(templateGrid[j++]);
      bundle.excess.forEach((line, li) => { for (let brow of block) pushRow(mapRow(brow, { ...bundle, currentLine: line, currentLineIndex: li }), null); });
      i = j + 1; continue;
    }
    if (marker.startsWith("{{/")) { i++; continue; }
    let isLineRow = row.some(c => /\{\{\s*LineItem\./.test(String(c)));
    if (isLineRow) {
      if (!linesMain.length) pushRow(mapRow(row, { ...bundle, currentLine: null }), null);
      else linesMain.forEach((line, li) => pushRow(mapRow(row, { ...bundle, currentLine: line, currentLineIndex: li }), null));
    } else pushRow(mapRow(row, bundle), null);
    i++;
  }
  return { rows, headerFlags: styles.map(s => s === "header"), boldFlags: styles.map(s => s === "bold") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates (KV) + the workshop's current shared template as the default
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TEMPLATE = {
  id: "default",
  name: "Quote template (shared)",
  csv: [
    '{{@header}}No,Product Description,Qty,Monthly Price(USD),',
    '1,Cloudflare Enterprise contract,1,{{Quote.NetAmountMonthly}},',
    ',Contract Terms : {{Opportunity.Contract_Months__c}} months,,,',
    '{{#groups}}',
    ',{{Group.Name}},,,',
    ',{{LineItem.SBQQ__ProductName__c}},{{LineItem.SBQQ__Quantity__c}},{{LineItem.MRRTotal}},',
    '{{/groups}}',
    ',,,,',
    ',,,,',
    '{{@bold}}On-Demand Pricing,,,,',
    '{{@header}}No,Product Description,Qty,Monthly Price(USD),',
    '{{#excess}}',
    '{{LineItem.RowNumber}},{{LineItem.SBQQ__ProductName__c}},1,{{LineItem.ExcessUnitPrice}},',
    '{{/excess}}',
  ].join("\n"),
};
async function listTemplates(env) {
  let raw = await env.SESSIONS.get("templates:list");
  let arr = raw ? JSON.parse(raw) : [DEFAULT_TEMPLATE];
  if (!arr.length) arr = [DEFAULT_TEMPLATE];
  return arr;
}
async function saveTemplates(env, arr) {
  await env.SESSIONS.put("templates:list", JSON.stringify(arr));
}

// ─────────────────────────────────────────────────────────────────────────────
// Search + quote-list API
// ─────────────────────────────────────────────────────────────────────────────

async function searchOpportunities(env, session, term) {
  let t = escSOQL(term || "");
  if (!t.trim()) throw new Error("Please enter a search term.");
  let nameQ = "SELECT Id, Name, Account.Name, StageName, CloseDate FROM Opportunity WHERE Name LIKE '%" + t + "%' ORDER BY CloseDate DESC LIMIT 15";
  let r = await sfQuery(env, session, nameQ);
  if (r.records.length < 15) {
    let accounts = await sfQuery(env, session, "SELECT Id, Name FROM Account WHERE Name LIKE '%" + t + "%' LIMIT 10");
    let ids = accounts.records.map(a => a.Id);
    if (ids.length) {
      let r2 = await sfQuery(env, session, "SELECT Id, Name, Account.Name, StageName, CloseDate FROM Opportunity WHERE AccountId IN ('" + ids.join("','") + "') ORDER BY CloseDate DESC LIMIT 50");
      let seen = new Set(r.records.map(o => o.Id));
      for (let o of r2.records) { if (!seen.has(o.Id)) r.records.push(o); }
    }
  }
  return r.records
    .sort((a, b) => (b.CloseDate || "").localeCompare(a.CloseDate || ""))
    .map(o => ({ id: o.Id, name: o.Name, accountName: o.Account ? o.Account.Name : null, stage: o.StageName, closeDate: o.CloseDate }));
}

async function getQuotesForOpportunity(env, session, opportunityId) {
  let esc = escSOQL(opportunityId);
  let qR = await sfQuery(env, session, "SELECT Id, Name, Net_Amount_Discountable__c, Discretionary_Discount_Applied__c, Opportunity_Type__c FROM SBQQ__Quote__c WHERE SBQQ__Opportunity2__c = '" + esc + "' ORDER BY Name DESC LIMIT 100");
  let oppR = await sfQuery(env, session, "SELECT SBQQ__PrimaryQuote__c FROM Opportunity WHERE Id = '" + esc + "' LIMIT 1");
  let primaryId = oppR.records.length ? oppR.records[0].SBQQ__PrimaryQuote__c : null;
  return {
    primaryQuoteId: primaryId,
    quotes: qR.records.map(q => ({
      id: q.Id, name: q.Name, amount: q.Net_Amount_Discountable__c,
      opportunityId, opportunityType: q.Opportunity_Type__c,
      discountApplied: q.Discretionary_Discount_Applied__c, isPrimary: q.Id === primaryId,
    })),
  };
}

async function searchQuotes(env, session, term) {
  let t = escSOQL(term || "");
  if (!t.trim()) throw new Error("Please enter a search term.");
  let r = await sfQuery(env, session,
    "SELECT Id, Name, Net_Amount_Discountable__c, SBQQ__Opportunity2__c, SBQQ__Opportunity2__r.Name " +
    "FROM SBQQ__Quote__c WHERE Name LIKE '%" + t + "%' ORDER BY LastViewedDate DESC LIMIT 25");
  return r.records.map(q => ({
    id: q.Id, name: q.Name, amount: q.Net_Amount_Discountable__c,
    opportunityId: q.SBQQ__Opportunity2__c,
    opportunityName: q.SBQQ__Opportunity2__r ? q.SBQQ__Opportunity2__r.Name : null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets export
// ─────────────────────────────────────────────────────────────────────────────

async function sheets(env, session, method, path, body) {
  let r = await googleFullFetch(env, session, SHEETS_V4 + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function exportToSheet(env, session, spreadsheetId, templateId, quoteId, options) {
  let templates = await listTemplates(env);
  let t = templates.find(x => x.id === templateId);
  if (!t) throw new Error("Template not found.");
  let bundle = await fetchBundle(env, session, quoteId, null);
  let mode = options && options.mode === "summary" ? "summary" : "breakdown";
  let filled = buildFilledGrid(parseCsv(t.csv), bundle, mode);
  let ncols = Math.max(...filled.rows.map(r => r.length));
  let headerRowIndexes = new Set([0, ...filled.headerFlags.map((f, i) => f ? i + 2 : -1).filter(i => i >= 0)]);
  let boldRowIndexes = new Set([...filled.boldFlags.map((f, i) => f ? i + 2 : -1).filter(i => i >= 0)]);

  let rawName = options && options.tabName ? String(options.tabName).trim() : "";
  let tabName = rawName || (bundle.Quote.Name + " — " + t.name);
  tabName = tabName.replace(/[\[\]\*\/\\\?\:]/g, "-").slice(0, 100);

  let now = new Date();
  let header = ["Quote: " + bundle.Quote.Name, null, null, "Generated: " + now.toISOString().slice(0, 16).replace("T", " ")];
  let startRow = 1;
  let values = [header, ...filled.rows.map(r => { let row = r.slice(); while (row.length < ncols) row.push(null); return row; })];
  let endRow = startRow + values.length - 1;

  // 1. Ensure the tab exists (create if missing).
  let meta = await sheets(env, session, "GET", encodeURIComponent(spreadsheetId) + "?fields=sheets(sheetId,properties)");
  let existing = (meta.sheets || []).find(s => s.properties.title === tabName);
  let tabSheetId = existing && existing.properties.sheetId != null ? existing.properties.sheetId : null;
  if (tabSheetId == null && !existing) {
    let addResp = await sheets(env, session, "POST", encodeURIComponent(spreadsheetId) + ":batchUpdate", { requests: [{ addSheet: { properties: { title: tabName } } }] });
    tabSheetId = addResp.replies && addResp.replies[0] && addResp.replies[0].addSheet && addResp.replies[0].addSheet.properties.sheetId;
  }
  let sheetId = tabSheetId != null ? tabSheetId : (existing ? existing.sheetId : null);

  // 2. Clear values (bounded clear) + a wide enough format reset.
  await sheets(env, session, "POST", encodeURIComponent(spreadsheetId) + "/values/" + encodeURIComponent("'" + tabName + "'!A" + startRow + ":AZ" + (startRow + 300)) + ":clear", {});
  let resetCols = Math.max(ncols, 18);
  let requests = [
    {
      updateCells: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 300, startColumnIndex: 0, endColumnIndex: resetCols },
        rows: [{ values: [{ userEnteredFormat: {} }] }],
        fields: "userEnteredFormat",
      },
    },
  ];
  // Bold title row.
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: ncols },
      cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.992, green: 0.909, blue: 0.831 } } },
      fields: "userEnteredFormat(textFormat.bold,backgroundColor)",
    },
  });
  // Header rows (light-orange + bold).
  for (let idx of headerRowIndexes) {
    if (idx === 0 || idx >= values.length) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: idx - 1, endRowIndex: idx, startColumnIndex: 0, endColumnIndex: ncols },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.992, green: 0.909, blue: 0.831 } } },
        fields: "userEnteredFormat(textFormat.bold,backgroundColor)",
      },
    });
  }
  // Bold-only rows.
  for (let idx of boldRowIndexes) {
    if (idx >= values.length || headerRowIndexes.has(idx)) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: idx - 1, endRowIndex: idx, startColumnIndex: 0, endColumnIndex: ncols },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: "userEnteredFormat(textFormat.bold)",
      },
    });
  }
  // Borders on the main table + bounded clean-up around it.
  let tableEndCol = ncols;
  let bw = "SOLID";
  let border = { style: bw, color: { red: 0, green: 0, blue: 0, alpha: 1 } };
  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: values.length, startColumnIndex: 0, endColumnIndex: tableEndCol },
      top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border,
    },
  });
  // Clean-out borders far below the table.
  let nocol = { style: "NONE", color: { red: 0, green: 0, blue: 0, alpha: 1 } };
  let cleanBottomEnd = Math.min(300, values.length + 6);
  if (cleanBottomEnd > values.length) {
    requests.push({
      updateBorders: {
        range: { sheetId, startRowIndex: values.length, endRowIndex: cleanBottomEnd, startColumnIndex: 0, endColumnIndex: tableEndCol },
        top: nocol, bottom: nocol, left: nocol, right: nocol, innerHorizontal: nocol, innerVertical: nocol,
      },
    });
  }
  await sheets(env, session, "POST", encodeURIComponent(spreadsheetId) + ":batchUpdate", { requests });

  // 3. Write values.
  let values2 = values.map(r => r.map(c => (c == null ? "" : typeof c === "number" ? c : c)));
  await sheets(env, session, "PUT", encodeURIComponent(spreadsheetId) + "/values/" + encodeURIComponent("'" + tabName + "'!A" + startRow + ":" + colLetter(ncols) + endRow) + "?valueInputOption=USER_ENTERED", { values: values2 });

  return {
    tabName,
    url: "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/edit#gid=" + (sheetId != null ? sheetId : ""),
    startRow, endRow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

function jsonRes(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

async function handleApi(env, request, session, url) {
  let path = url.pathname;
  if (path === "/api/session" && request.method === "GET") {
    return jsonRes({
      sfConnected: !!(session && session.sf),
      googleConnected: !!(session && session.google && session.google.accessToken),
      spreadsheetId: (await env.SESSIONS.get("settings:sheetId")) || "",
    });
  }
  if (path === "/api/settings" && request.method === "POST") {
    let b = await request.json();
    if (b && b.spreadsheetId != null) await env.SESSIONS.put("settings:sheetId", String(b.spreadsheetId).trim());
    return jsonRes({ ok: true });
  }
  if (path === "/api/opps/search" && request.method === "POST") {
    let b = await request.json();
    let items = b.quoteMode ? await searchQuotes(env, session, b.term) : await searchOpportunities(env, session, b.term);
    return jsonRes({ items });
  }
  if (path === "/api/opps/quotes" && request.method === "POST") {
    let b = await request.json();
    return jsonRes(await getQuotesForOpportunity(env, session, b.opportunityId));
  }
  if (path === "/api/preview" && request.method === "POST") {
    let b = await request.json();
    let templates = await listTemplates(env);
    let t = templates.find(x => x.id === b.templateId);
    if (!t) return jsonRes({ error: "Template not found." }, 404);
    let bundle = await fetchBundle(env, session, b.quoteId, null);
    let mode = b.mode === "summary" ? "summary" : "breakdown";
    let filled = buildFilledGrid(parseCsv(t.csv), bundle, mode);
    return jsonRes({
      quoteName: bundle.Quote.Name, mode,
      opportunityName: bundle.Opportunity ? bundle.Opportunity.Name : null,
      accountName: bundle.Account ? bundle.Account.Name : null,
      lineCount: bundle.lines.length,
      rows: filled.rows, headerFlags: filled.headerFlags, boldFlags: filled.boldFlags,
    });
  }
  if (path === "/api/export" && request.method === "POST") {
    let b = await request.json();
    let sheetId = b.spreadsheetId || (await env.SESSIONS.get("settings:sheetId")) || "";
    if (!sheetId) return jsonRes({ error: "No spreadsheet ID configured. Set it in the settings box." }, 400);
    let r = await exportToSheet(env, session, sheetId.trim(), b.templateId, b.quoteId, b);
    return jsonRes(r);
  }
  if (path === "/api/templates" && request.method === "GET") {
    return jsonRes({ templates: await listTemplates(env) });
  }
  if (path === "/api/templates" && request.method === "POST") {
    let b = await request.json();
    let arr = await listTemplates(env);
    let existing = b.id ? arr.find(x => x.id === b.id) : null;
    if (!b.name) return jsonRes({ error: "Template needs a name." }, 400);
    if (existing) { existing.name = b.name; if (b.csv != null) existing.csv = String(b.csv); }
    else arr.push({ id: "t" + Date.now(), name: String(b.name), csv: String(b.csv || DEFAULT_TEMPLATE.csv) });
    await saveTemplates(env, arr);
    return jsonRes({ ok: true, templates: arr });
  }
  if (path === "/api/templates/delete" && request.method === "POST") {
    let b = await request.json();
    let arr = (await listTemplates(env)).filter(x => x.id !== b.id);
    if (!arr.length) arr = [DEFAULT_TEMPLATE];
    await saveTemplates(env, arr);
    return jsonRes({ ok: true });
  }
  // Step 4 variant used by the template editor's field-hints (direct describe now possible).
  if (path === "/api/describe" && request.method === "POST") {
    let b = await request.json();
    try {
      let d = await sfFullFetch(env, session, session.sf, "/sobjects/" + encodeURIComponent(b.objectName) + "/describe");
      let fields = (d.fields || []).map(f => ({ name: f.name, label: f.label, type: f.type }));
      return jsonRes({ fields });
    } catch (e) { return jsonRes({ error: e.message.slice(0, 300) }, 500); }
  }
  return jsonRes({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    let url = new URL(request.url);
    let path = url.pathname;

    // OAuth
    if (path === "/auth/sf" || path === "/auth/sf/callback") return path.endsWith("callback") ? oauthCallback("sf", request, env) : oauthStart("sf", request, env);
    if (path === "/auth/google" || path === "/auth/google/callback") return path.endsWith("callback") ? oauthCallback("google", request, env) : oauthStart("google", request, env);

    if (path.startsWith("/api/")) {
      let session = await getSession(env, request);
      // /api/session must work pre-login (the SPA uses it to decide which Connect links to show).
      if (!session && path === "/api/session") {
        return jsonRes({ sfConnected: false, googleConnected: false, spreadsheetId: (await env.SESSIONS.get("settings:sheetId")) || "" });
      }
      if (!session) return jsonRes({ error: "Not connected. Please connect accounts first." }, 401);
      {
        let m = /(?:^|;\s*)sid=([0-9a-f]{32})/.exec(request.headers.get("Cookie") || "");
        if (m) session.__sid = m[1];
      }
      // API errors translate to JSON so the SPA can show them (instead of HTML).
      try {
        return await handleApi(env, request, session, url);
      } catch (e) {
        return jsonRes({ error: (e && e.message) ? String(e.message).slice(0, 500) : String(e) }, 500);
      }
    }
    // Everything else is the static SPA.
    return env.ASSETS.fetch(request);
  },
};
