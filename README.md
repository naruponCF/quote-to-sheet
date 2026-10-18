# Quote → Google Sheet

Standalone web app (Cloudflare Worker) that searches **Salesforce CPQ (SBQQ) quotes**,
previews a pricing table, and exports it into a **formatted Google Sheets tab** — one tab per quote.

This is the standalone edition of the workspace prototype. Everything the prototype did is ported:
SKU folding rules, annualized monthly math, templates, preview, overwrite-into-tab export.

---

## How it works

| Piece | Technology |
|---|---|
| Frontend | Single-page app served from a Cloudflare Worker (`public/`) |
| Backend | Same Worker: OAuth sessions, SOQL queries, Google Sheets export (`src/index.js`) |
| Sessions/templates | Workers KV (`SESSIONS`) |
| Data sources | Salesforce REST API, Google Sheets API v4 |
| Deploy | Git push → Cloudflare Workers Builds auto-deploys |

The app reads **every field it needs directly from Salesforce** (no field allowlist, no 300 query/day cap — those were limitations of the workshop connector, not the org's API).

### Quote business rules baked in

- **Monthly prices = annualized** ("Monthly Cap" SKUs are priced per year, then ÷ 12) — regardless of contract months on the opportunity.
- **Container/roll-up SKUs dropped**: product codes with `-CONT-` (e.g. `WADWXN-CONT-…`, all `… Monthly Cap` tops with no per-unit like a support container) are hidden; their child SKUs carry the pricing.
- **Geolocation SKUs folded into Global**: any `… (Asia)/(Europe)/(North America)/… Monthly Cap` line's price rolls up into the matching `… Global Monthly Cap` row, and regional rows disappear from the table.
- **"Excess Price" usage SKUs** go in the separate *On-Demand Pricing* table at the bottom, dedupe by SKU name, with their per-unit rate.
- **Contract row monthly total** mirrors the SFDC quote list's MRR: when the quote's *Net Amount Discountable* equals Σ lines, it uses quote-level value ÷ 12; when usage-billed SKUs (e.g. R2 Storage) are excluded from the quote's Net Amount, it uses Σ per-line MRR instead.
- Rounding is **half-even** (banker's) — best match against SFDC across verified quotes.

---

## One-time setup

### A. Salesforce Connected App (ask an SFDC admin if needed)

1. **Setup → App Manager → New Connected App**
   - Enable OAuth Settings
   - Callback URL: `https://<your-worker>.workers.dev/auth/sf/callback`
   - Scopes: *Access and manage your data (api)*, *Perform requests at any time (refresh_token, offline_access)*
2. Copy **Consumer Key** and **Consumer Secret** → these become `SF_CLIENT_ID` / `SF_CLIENT_SECRET`.

### B. Google OAuth client

1. Google Cloud Console → create a project → enable **Google Sheets API** + **Google Drive API**.
2. **Credentials → OAuth client ID → Web application**:
   - Authorized redirect URIs: `https://<your-worker>.workers.dev/auth/google/callback`
3. Client ID / secret → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. (Testing: publish the OAuth consent screen as **External → Testing**, add yourself as a test user.)

### C. Deploy

1. Edit **`wrangler.toml`**: create the KV namespace once —
   ```bash
   npx wrangler kv namespace create SESSIONS    # prints an id
