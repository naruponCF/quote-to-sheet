// "Quote → Google Sheet" standalone SPA. Talks to the Worker API (OAuth'd session).

const app = document.getElementById("app");

function h(tag, attrs, ...kids) {
  let el = document.createElement(tag);
  for (let [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (let kid of kids) {
    if (kid == null) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, body) {
  let r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = await r.json().catch(() => ({}));
  if (r.status === 401) { location.reload(); return new Promise(() => {}); }
  if (data && data.error) throw new Error(data.error);
  return data;
}
async function apiGet(path) {
  let r = await fetch(path);
  if (r.status === 401) { location.reload(); return new Promise(() => {}); }
  return r.json();
}

function fmtAmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────

const state = {
  session: { sfConnected: false, googleConnected: false, spreadsheetId: "" },
  opp: null, quote: null,
  quotes: [], mode: "breakdown",
  templates: [], template: null,
  previewRows: null, previewMeta: null,
  searching: false,
};

function renderConnect() {
  app.replaceChildren();
  app.append(
    h("h1", { class: "" }, h("span", { class: "arrow" }, "➜"), " Quote to Google Sheet"),
    h("p", { class: "sub" }, "Export a Salesforce CPQ quote into a formatted Google Sheets tab.")
  );
  let card = h("div", { class: "card" },
    h("h2", {}, "Step 1 — Connect accounts"),
    h("div", { class: "connect-bar" },
      h("a", { href: "/auth/sf", class: "" },
        h("span", { class: "pill" }, h("span", { class: "status-dot " + (state.session.sfConnected ? "ok" : "no") }), "Connect Salesforce")),
      h("a", { href: "/auth/google" },
        h("span", { class: "pill" }, h("span", { class: "status-dot " + (state.session.googleConnected ? "ok" : "no") }), "Connect Google (Sheets)")),
    ),
  );

  // Spreadsheet setting — only useful once Google is connected.
  let sheetInput = h("input", { type: "text", class: "grow", placeholder: "Spreadsheet ID or Google Sheet URL", value: state.session.spreadsheetId || "" });
  let saveBtn = h("button", {}, "Save", {}, 0);
  saveBtn.addEventListener("click", async () => {
    let v = sheetInput.value.trim();
    let m = v.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m) v = m[1];
    await api("/api/settings", { spreadsheetId: v });
    sheetInput.value = v; renderStatus(h("div", { class: "banner" }, h("b", {}, "Saved ✓ "), "Spreadsheet target stored."));
  });
  sheetInput.addEventListener("change", () => { });

  let statusBox = h("div", {});
  function renderStatus(node) { statusBox.replaceChildren(node); }
  statusBox.replaceChildren();

  card.append(h("div", { class: "field", style: "margin-top:14px" },
    h("label", {}, "Target Google Sheet (exports overwrite one tab per quote)"),
    h("div", { class: "row" }, sheetInput, saveBtn), statusBox));

  app.append(card);
  if (state.session.sfConnected && state.session.googleConnected) {
    let startBtn = h("button", { class: "primary" }, "Start exporting →");
    startBtn.addEventListener("click", renderSearch);
    card.append(h("div", { style: "margin-top:14px" }, startBtn));
  }
}

// ── Search / select ──────────────────────────────────────────────────────────

function renderSearch() {
  app.replaceChildren();
  app.append(
    h("h1", {}, h("span", { class: "arrow" }, "➜"), " Quote to Google Sheet"),
    h("p", { class: "sub" }, "Find a Salesforce opportunity or direct quote, preview the pricing table, export it into your sheet tab.")
  );

  let searchWrap = h("div", { class: "suggest grow" });
  let input = h("input", { type: "text", class: "grow", placeholder: "Type 2+ characters: opportunity name, account name, or Q-number…", autocomplete: "off" });
  let listBox = h("div", { class: "list" });
  searchWrap.append(input, listBox);

  let note = h("div", { class: "tail" });

  let searchCard = h("div", { class: "card" },
    h("h2", {}, "Step 1 — Find your opportunity or quote"),
    h("div", { class: "row" }, searchWrap),
    note,
  );

  let quoteCard = h("div", { class: "card hidden" });
  let exportCard = h("div", { class: "card hidden" });
  app.append(searchCard, quoteCard, exportCard);

  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    let v = input.value.trim();
    if (v.length < 2) { listBox.classList.remove("open"); return; }
    timer = setTimeout(async () => {
      try {
        let isQuote = /^Q-\d+$/i.test(v) || state.quoteSearchMode;
        let r = await api("/api/opps/search", { term: v, quoteMode: isQuote });
        listBox.replaceChildren();
        let items = r.items || [];
        if (!items.length) listBox.append(h("div", { class: "item" }, h("span", { class: "m" }, "No matches.")));
        for (let it of items.slice(0, 12)) {
          let el = isQuote
            ? h("div", { class: "item" }, h("div", { class: "n" }, (it.opportunityName ? it.opportunityName + " • " : "") + it.name), h("div", { class: "m" }, "Net: " + fmtAmt(it.amount)))
            : h("div", { class: "item" }, h("div", { class: "n" }, it.name), h("div", { class: "m" }, [it.accountName, it.stage, it.closeDate].filter(Boolean).join(" • ")));
          el.addEventListener("click", () => { listBox.classList.remove("open"); pick(it, isQuote); });
          listBox.append(el);
        }
        listBox.classList.add("open");
      } catch (e) { note.textContent = "Search error: " + e.message; }
    }, 350);
  });
  document.addEventListener("click", (ev) => { if (!searchWrap.contains(ev.target)) listBox.classList.remove("open"); });

  async function pick(item, isQuote) {
    if (isQuote) {
      state.opp = null;
      await afterDualFetch({ id: item.opportunityId, name: item.opportunityName || "" }, item);
    } else {
      state.opp = { id: item.id, name: item.name, accountName: item.accountName || null };
      input.value = item.name;
      note.textContent = "Loading quotes…";
      try {
        let r = await api("/api/opps/quotes", { opportunityId: item.id });
        state.quotes = r.quotes || [];
        note.textContent = state.quotes.length ? "" : "No quotes on this opportunity.";
        quoteCard.classList.remove("hidden");
        renderQuoteCard(quoteCard, exportCard, r.primaryQuoteId, item.id);
      } catch (e) { note.textContent = "Load error: " + e.message; }
    }
  }

  async function afterDualFetch(oppLike, quote) {
    state.opp = { id: oppLike.id, name: oppLike.name, accountName: null };
    state.quote = quote;
    quoteCard.classList.remove("hidden");
    exportCard.classList.remove("hidden");
    renderQuoteCard(quoteCard, exportCard, null, oppLike.id);
    renderExportCard(exportCard);
    renderPreviewAuto();
  }

  function renderQuoteCard(card, xcard, primaryQuoteId, oppId) {
    card.replaceChildren(h("h2", {}, "Step 2 — Pick the quote"));
    let select = h("select", { class: "grow" });
    select.append(h("option", { value: "" }, "Select a quote…"));
    for (let q of state.quotes) {
      let label = q.name + " • Net: " + fmtAmt(q.amount) + (q.opportunityType ? " • " + q.opportunityType : "");
      select.append(h("option", { value: q.id }, (q.isPrimary ? "⭐ " : "") + label));
    }
    if (state.quotes.length === 1) { select.value = state.quotes[0].id; state.quote = state.quotes[0]; }
    select.addEventListener("change", () => {
      state.quote = state.quotes.find(q => q.id === select.value) || null;
      if (state.quote) { xcard.classList.remove("hidden"); renderExportCard(xcard); renderPreviewAuto(); }
    });
    let hint = h("div", { class: "tail" }, state.quotes.length === 1 ? "Only one quote — selected automatically." : "");
    card.append(select, hint);
    if (state.quote) { xcard.classList.remove("hidden"); renderExportCard(xcard); renderPreviewAuto(); }
  }
}

// ── Export card ─────────────────────────────────────────────────────────────

function renderExportCard(card) {
  card.replaceChildren();
  card.append(h("h2", {}, "Step 3 — Preview & export"));
  if (!state.quote) { card.append(h("div", { class: "tail" }, "Pick a quote above first.")); return; }

  // Selected banner
  card.append(h("div", { class: "banner" }, h("b", {}, "✅ Selected quote: "),
    state.quote.name + " • Net: " + fmtAmt(state.quote.amount)));

  // Mode radio
  let modeRow = h("div", { class: "modebox" });
  for (let m of [["breakdown", "Pricing Breakdown"], ["summary", "Pricing Summary"]]) {
    let radio = h("input", { type: "radio", name: "pmode", value: m[0], id: "pmode_" + m[0] });
    if (state.mode === m[0]) radio.checked = true;
    radio.addEventListener("change", () => { state.mode = m[0]; renderPreviewAuto(); });
    modeRow.append(h("label", { for: "pmode_" + m[0] }, radio, m[1]));
  }
  card.append(modeRow);

  // Template picker
  let tsel = h("select", { class: "grow" });
  if (!state.templates.length) { /* loaded by caller */ }
  for (let t of state.templates) tsel.append(h("option", { value: t.id }, t.name + (t.id === "default" ? " (shared)" : "")));
  if (state.template) tsel.value = state.template.id;
  tsel.addEventListener("change", () => { state.template = state.templates.find(t => t.id === tsel.value) || null; renderPreviewAuto(); });
  card.append(h("div", { class: "field" }, h("label", {}, "Template"), tsel));

  // Tab name
  let tabInput = h("input", { type: "text", class: "grow", value: state.quote.name, placeholder: "Sheet tab name" });
  card.append(h("div", { class: "field" }, h("label", {}, "Sheet tab name (one tab per quote; re-export overwrites)"), tabInput));

  // Target sheet
  let sheetInput = h("input", { type: "text", class: "grow", placeholder: "Spreadsheet ID or URL", value: state.session.spreadsheetId || "" });
  card.append(h("div", { class: "field" }, h("label", {}, "Target Google Sheet"), sheetInput));

  // Preview area + buttons
  let previewBox = h("div", {});
  card.append(previewBox);

  let statusBox = h("div", {});
  let exportBtn = h("button", { class: "primary" }, "Export to Google Sheet");
  let statusMsg = h("div", { class: "tail" });

  exportBtn.addEventListener("click", async () => {
    let sid = sheetInput.value.trim();
    let m = sid.match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/); if (m) sid = m[1];
    statusMsg.textContent = "Exporting…";
    exportBtn.disabled = true;
    try {
      let r = await api("/api/export", {
        templateId: state.template ? state.template.id : "default",
        quoteId: state.quote.id,
        mode: state.mode, tabName: tabInput.value.trim(), spreadsheetId: sid,
      });
      statusBox.replaceChildren(h("div", { class: "banner" }, h("b", {}, "✅ Exported "),
        h("a", { href: r.url, target: "_blank", rel: "noopener" }, "Open “" + r.tabName + "” in your sheet →")));
    } catch (e) {
      statusBox.replaceChildren(h("div", { class: "banner err" }, h("b", {}, "Export failed: "), e.message));
    }
    statusMsg.textContent = "";
    exportBtn.disabled = false;
  });
  card.append(h("div", { class: "row", style: "margin-top:12px" }, exportBtn), statusBox, statusMsg);

  // Template editor
  let editor = h("div", { class: "hidden" });
  let showBtn = h("button", {}, "Edit templates…");
  showBtn.addEventListener("click", async () => {
    editor.classList.toggle("hidden");
    if (!editor.classList.contains("hidden") && !editor.childElementCount) await renderTemplateEditor(editor);
  });
  card.append(h("div", { style: "margin-top:10px" }, showBtn), editor);

  // Preview rendering
  async function renderPreviewAuto() {
    previewBox.replaceChildren();
    if (!state.quote || !state.template) return;
    previewBox.append(h("div", { class: "tail" }, "Loading preview…"));
    try {
      let p = await api("/api/preview", { templateId: state.template.id, quoteId: state.quote.id, mode: state.mode });
      previewBox.replaceChildren();
      previewBox.append(h("div", { class: "tail" },
        "Preview • Quote " + p.quoteName + (p.accountName ? " • " + p.accountName : "") + " • " + p.lineCount + " lines • " + p.mode));
      previewBox.append(renderTable(p.rows, { headerFlags: p.headerFlags, boldFlags: p.boldFlags }));
    } catch (e) { previewBox.replaceChildren(h("div", { class: "banner err" }, h("b", {}, "Preview failed: "), e.message)); }
  }
  state.__preview = renderPreviewAuto;
}

function renderTable(rows, opts) {
  let t = h("table", { class: "grid" });
  rows.forEach((row, ri) => {
    let tr = h("tr", {});
    if (opts.headerFlags && opts.headerFlags[ri]) tr.className = "hdr";
    if (opts.boldFlags && opts.boldFlags[ri]) tr.className = (tr.className ? tr.className + " " : "") + "bld";
    row.forEach((cell, ci) => {
      let v = cell == null || cell === "" ? (ri === 0 ? "" : "") : String(cell);
      if (typeof cell === "number") v = fmtAmt(cell);
      tr.append(h("td", { style: ci === 2 || ci === 3 || (typeof cell === "number") ? "text-align:right" : "" }, v));
    });
    t.append(tr);
  });
  return t;
}

async function renderPreviewAuto() { if (state.__preview) return state.__preview(); }

// ── Template editor ─────────────────────────────────────────────────────────

async function renderTemplateEditor(box) {
  box.replaceChildren(h("h2", {}, "Templates"), h("div", { class: "tail" }, " CSV grid with {{Placeholders}}; {{#groups}}/{{#excess}} auto-repeat; {{@header}}/{{@bold}} styling."));

  let tplList = h("div", {});
  let nameInput = h("input", { type: "text", placeholder: "Template name", class: "grow" });
  let csvArea = h("textarea", { class: "templ" });
  let saveBtn = h("button", { class: "primary" }, "Save changes");
  let delBtn = h("button", {}, "Delete selected");
  let newBtn = h("button", {}, "New template");
  let hintSel = h("select", {});
  hintSel.append(h("option", { value: "" }, "Insert field hint…"));
  let hints = [
    ["Quote", ["{{Quote.Name}} (Q-number)", "{{Quote.NetAmountMonthly}} (contract monthly)", "{{Quote.Net_Amount_Discountable__c}}"]],
    ["Opportunity", ["{{Opportunity.Name}}", "{{Opportunity.Contract_Months__c}}", "{{Opportunity.Account.Name}}"]],
    ["Group", ["{{Group.Name}}"]],
    ["LineItem", ["{{LineItem.SBQQ__ProductName__c}}", "{{LineItem.SBQQ__Quantity__c}}", "{{LineItem.MRRTotal}} (monthly, computed)", "{{LineItem.SBQQ__NetTotal__c}}", "{{LineItem.SBQQ__ProductCode__c}}", "{{LineItem.RowNumber}}", "{{LineItem.ExcessUnitPrice}}"]],
    ["Totals", ["{{Totals.LineCount}}", "{{Totals.NetTotal}}"]],
  ];
  for (let [obj, fs] of hints) {
    let grp = h("optgroup", { label: obj });
    for (let f of fs) grp.append(h("option", { value: f.split(")")[0] + (f.includes(")") ? ")" : "") }, f));
    hintSel.append(grp);
  }
  hintSel.addEventListener("change", () => { if (!hintSel.value) return; let m = hintSel.value.match(/\{\{[^}]+\}\}/); if (m) insertAtCursor(csvArea, m[0]); hintSel.value = ""; });
  function insertAtCursor(ta, text) { let s = ta.selectionStart || 0, e = ta.selectionEnd || 0; ta.value = ta.value.slice(0, s) + text + ta.value.slice(e); ta.focus(); }

  function clearSelection() { state.template = null; nameInput.value = ""; csvArea.value = state.templates[0] ? state.templates[0].csv : ""; renderList(); }
  function selectTemplate(t) {
    state.template = t; nameInput.value = t.name; csvArea.value = t.csv; renderList();
  }
  function renderList() {
    tplList.replaceChildren();
    for (let t of state.templates) {
      let b = h("button", {}, t.name + (state.template && state.template.id === t.id ? " ✓" : ""));
      b.addEventListener("click", () => selectTemplate(t));
      tplList.append(b);
    }
  }
  newBtn.addEventListener("click", clearSelection);
  saveBtn.addEventListener("click", async () => {
    await api("/api/templates", { id: state.template ? state.template.id : undefined, name: nameInput.value.trim(), csv: csvArea.value });
    let r = await apiGet("/api/templates"); state.templates = r.templates;
    state.template = state.templates.find(t => t.name === nameInput.value.trim()) || state.templates[0];
    renderList();
  });
  delBtn.addEventListener("click", async () => {
    if (!state.template) return;
    await api("/api/templates/delete", { id: state.template.id });
    let r = await apiGet("/api/templates"); state.templates = r.templates; state.template = state.templates[0];
    renderList();
  });

  box.append(
    h("div", { class: "templ-row" }, tplList),
    h("div", { class: "field" }, h("label", {}, "Template name"), nameInput),
    h("div", { class: "field" }, h("label", {}, "CSV grid"), csvArea),
    h("div", { class: "row" }, hintSel),
    h("div", { class: "row", style: "margin-top:10px" }, saveBtn, delBtn, newBtn),
    h("p", { class: "tail" },
      "Field hints come directly from Salesforce describe (full org schema available). LOOKUP note: container SKUs (-CONT-), regional geos, and \"Excess Price\" rows are folded/dropped automatically; values of Monthly Price are annualized ÷ 12 to mirror the SFDC quote's MRR column as closely as possible.")
  );
  if (!state.template && state.templates.length) selectTemplate(state.templates[0]);
  else renderList();
}

// ── Boot ────────────────────────────────────────────────────────────────────

(async function boot() {
  try {
    let s = await apiGet("/api/session");
    state.session = s;
    let tr = await apiGet("/api/templates").catch(() => ({ templates: [] }));
    state.templates = tr.templates || [];
    state.template = state.templates[0] || null;
  } catch (e) { /* offline/unauth — renderConnect will show connect links */ }
  renderConnect();
})();
