# US Equities + ETF Options Screener

A free, end-to-end options screener for US equities (S&P 500 + Nasdaq-100) and the major ETFs:

- **Data source:** CBOE delayed quotes (official exchange data, includes Greeks) loaded into a Cloudflare-hosted Apache Iceberg lake by the in-repo loader (`loader/`: CBOE → Cloudflare Pipelines → R2 Data Catalog). This repo consumes that lake directly over **R2 SQL** — no local database, no Parquet, no in-browser DuckDB.
- **Backend:** a lightweight **Cloudflare Worker** (`worker/`) that queries the Iceberg lake over the R2 SQL REST API and returns JSON. Deployed via `wrangler deploy`.
- **Frontend:** React + TypeScript (Vite) — a plain `fetch()` client; no WASM, no Parquet, no httpfs.
- **Toolchain:** managed with [mise](https://mise.jdx.dev) (Node, wrangler).

```
loader/ (in this repo):
  CBOE → Cloudflare Pipelines → R2 Data Catalog Iceberg tables
                                        │
                                        ▼
lobster-market-pricing Worker (worker/):
  /api/* → R2 SQL REST endpoint → JSON (in-isolate cache, 30 min–12 h by tier)
                                        │
                                        ▼
lobster-market-pricing frontend (Vite + React):
  fetch('/api/*') → render
```

The Worker is the only runtime component on this side. It's a thin SQL-string
builder + cache over the R2 SQL REST endpoint — exactly what the old FastAPI
backend was over DuckDB, ported to DataFusion SQL. Uncached lake queries take
1–6 s; the Worker memoizes them in-isolate (data is nightly-refreshed, so
staleness is bounded and the cache is safe to keep for 30 min–12 h per data
tier) so repeat/cached responses are instant.

## Repo layout

```
lobster-market-pricing/
├── mise.toml              # tool versions + tasks (Node, wrangler)
├── worker/                # Cloudflare Worker backend (R2 SQL → JSON)
│   ├── src/index.ts        # all endpoints, R2 SQL client, in-isolate cache
│   ├── wrangler.jsonc       # Worker config (R2_SQL_ACCOUNT_ID, R2_SQL_BUCKET vars)
│   └── .dev.vars            # local-dev R2_SQL_TOKEN (gitignored)
├── frontend/              # Vite + React + TS UI
│   ├── src/{App.tsx, api.ts, App.css, DataPage.tsx, AiChat.tsx, …}
│   ├── .env                # VITE_API_BASE → deployed Worker URL
│   └── vite.config.ts
└── loader/                # CBOE → Pipelines → R2 Data Catalog loader (Worker + Container)
    ├── src/index.js         # Worker endpoint + Container routing (cboe-to-r2)
    ├── container/loader.py  # CBOE fetch, OCC normalization, batching, refresh publication
    ├── tools/load_sp500.py  # resumable symbol driver (one-shot loads)
    ├── tools/refresh_universe.py  # rebuild symbols/universe.json (see loader/AGENTS.md)
    ├── symbols/             # universe.json (S&P 500 + Nasdaq-100 + ETFs) + sp500.json constituents
    ├── schemas/             # Pipeline input schemas
    ├── Dockerfile           # container image (Python 3.12)
    └── wrangler.jsonc       # Worker + Container config (Pipeline URLs are secrets, not vars)

## Prerequisites

Only [mise](https://mise.jdx.dev) is required. Node 24, Python 3.12, and
wrangler are pinned in `mise.toml` and installed automatically:

```bash
mise trust        # one-time: trust this project's config
mise install      # install pinned tools
mise run sync     # npm install (frontend + worker)
mise run loader-install  # npm ci (loader)
```

## Configuration

### Worker — `R2_SQL_TOKEN` (secret)

The Worker authenticates to the R2 SQL REST API with a Cloudflare API token
that has **R2 SQL Read** on the lake bucket. It is stored as a Worker secret
(never in plaintext config):

```bash
cd worker && npx wrangler secret put R2_SQL_TOKEN
# paste the token (same one the in-repo loader uses as
# WRANGLER_R2_SQL_AUTH_TOKEN)
```

For local dev, put the same value in `worker/.dev.vars` (gitignored):

```
R2_SQL_TOKEN=cfat_...
```

`worker/wrangler.jsonc` sets the non-secret connection values as vars:

- `R2_SQL_ACCOUNT_ID` — Cloudflare account ID hosting the lake
- `R2_SQL_BUCKET` — R2 bucket with Data Catalog enabled (warehouse is `{ACCOUNT_ID}_{BUCKET}`)
- `CORS_ORIGIN` — fallback `*` for untrusted origins. Credentialed Copilot login (including `/api/auth/*`) echoes a trusted `Origin` (lobster.mp and siblings) with `Access-Control-Allow-Credentials`. Better Auth itself does not set CORS headers.

### Loader — `LOADER_TOKEN` (secret)

The loader Worker (`loader/`, deployed as `cboe-to-r2`) protects its `/run`,
`/symbols/enroll`, `/loop/trigger`, and `/jobs/*/trigger` endpoints with a
bearer token. Store the value in **GitHub Actions secrets** (source of truth)
and on the loader Worker:

```bash
# once — GitHub (CI + force-loader-pass workflow)
gh secret set LOADER_TOKEN

# once — loader Worker (or let deploy-loader.yml keep verifying it exists)
cd loader && npx wrangler secret put LOADER_TOKEN
```

The **API Worker** (`screener-api` / `screener-api-dev`) needs the **same**
value so Copilot/research can call `POST /symbols/enroll` when a ticker is
missing from the lake. `Deploy` (`.github/workflows/deploy.yml`) syncs
`secrets.LOADER_TOKEN` onto both Workers on every deploy (same pattern as
`ADMIN_TOKEN`). Until that lands, set it by hand:

```bash
cd worker
printf '%s' "$LOADER_TOKEN" | npx wrangler secret put LOADER_TOKEN --name screener-api
printf '%s' "$LOADER_TOKEN" | npx wrangler secret put LOADER_TOKEN --name screener-api-dev
```

For local dev, put the same value in `loader/.dev.vars` and
`worker/.dev.vars` (gitignored; see `*.dev.vars.example`). Pipeline ingest URLs are **secrets** (the URL
subdomain IS the credential) — deployed via `wrangler secret put`, never in
`wrangler.jsonc`. See `loader/.dev.vars.example` for the full secret list.
The root `.env` holds `WRANGLER_R2_SQL_AUTH_TOKEN` for local `wrangler r2 sql
query` validation (gitignored; see `.env.example`).

### Worker — `OPEN_ROUTER_KEY` (secret, Copilot)

The Worker's server-side Copilot loop uses the site's OpenRouter key. Store it
as a Worker secret and mirror it in `worker/.dev.vars` for local development
(gitignored); it is never sent to the browser or committed. Non-secret vars in
`worker/wrangler.jsonc` select the single funded model (`COPILOT_MODEL`), its
reasoning effort (`COPILOT_REASONING_EFFORT`), and per-turn output/history caps
(`COPILOT_MAX_OUTPUT_TOKENS`, `COPILOT_MAX_HISTORY_CHARS`).

```bash
cd worker && npx wrangler secret put OPEN_ROUTER_KEY
```

### Worker — `IMPROVEMENT_ISSUE_TOKEN` (secret, optional)

After the timeline quality gate runs (human publish or bot share), a cheap
OpenRouter pass can propose **product improvements** and open GitHub issues on
this repo. Store a fine-grained PAT with **Issues: Read and write** on
`rlancer/lobster-market-pricing` (Contents not required). Unset = gate still
runs; no issues are filed. D1 `improvement_reports` dedupes by fingerprint so
the same failure mode does not spam the tracker. Issues are labeled
`copilot-improvement`. Cutoff variants collapse to
`assistant-answer-cutoff` / `unfinished-overview-no-final-answer`. The
reporter skips jailbreak/spam rejects (gate working as intended), synthetic
`test/*` harness shares, and vague LLM-only "unfinished" fallbacks.

```bash
# Create a fine-grained PAT → Issues: Read and write on this repo, then:
gh secret set IMPROVEMENT_ISSUE_TOKEN
cd worker && npx wrangler secret put IMPROVEMENT_ISSUE_TOKEN
# Optional override (defaults to rlancer/lobster-market-pricing):
# npx wrangler secret put IMPROVEMENT_ISSUE_REPO
```

### Worker — Better Auth (optional Copilot login)

Chat stays anonymous by default. Google OAuth is optional so a signed-in user
can reopen past conversations from the left nav. Sign in / Sign out live in
the app header so the account is available on every workspace page, not only
Copilot. The first sign-in asks for a public **handle** — a unique, lowercase
letters-and-numbers slug stored in D1 `user_profiles` (not on Better Auth's
`user` row). From the **Account** page (`/account`, via the left-nav profile
control) you can also set a **display name** and
upload a **custom avatar** (JPEG/PNG/WebP/SVG bytes in D1 `user_avatars`;
`user_profiles.avatar_key` is a presence sentinel, served at
`/api/avatars/{user_id}`). Handles are the URL slug for `/u/{handle}` (that
handle's public profile and opted-in chats). Chat ownership still keys off
`user_id`. A chat is cataloged onto the
user when they send a real turn (or when they sign in on a chat that already
has a transcript) — not when they merely open a new empty UUID. Identity is
Better Auth on the existing Worker D1 (`SCHEMA_DB` / `screener-schema-cache`). The
session is an HttpOnly, Secure, SameSite=Lax cookie; the Worker is the only
thing that ever writes `user_id`.

Cookie origin is a shared parent domain, not a token in localStorage:

| | Pages | Worker API |
| --- | --- | --- |
| Production | `https://lobster.mp` | `https://api.lobster.mp` |
| Preview | `https://dev.lobster.mp` | `https://api-dev.lobster.mp` |

The cookie is set on `lobster.mp` so it rides between those sibling hosts.
`workers.dev` and `pages.dev` URLs still serve the anonymous API; login
requires the product domain.

Store these as Worker secrets (and GitHub secrets so CI can re-inject them):

```bash
cd worker && npx wrangler secret put BETTER_AUTH_SECRET   # long random string
cd worker && npx wrangler secret put GOOGLE_CLIENT_ID
cd worker && npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Google Cloud OAuth client (Web application) authorized redirect URIs:

- `https://api.lobster.mp/api/auth/callback/google`
- `https://api-dev.lobster.mp/api/auth/callback/google`
- `http://127.0.0.1:8787/api/auth/callback/google` (local Worker)
- `http://localhost:5173/api/auth/callback/google` (Vite `/api` proxy)

Authorized JavaScript origins: `https://lobster.mp`, `https://dev.lobster.mp`,
`http://localhost:5173`, `http://127.0.0.1:5173`. Mirror the secrets in
`worker/.dev.vars` for local development.

### Charles Schwab connect (optional)

Signed-in users can link a Schwab brokerage OAuth grant from **Account →
Connect Schwab**. Tokens stay in D1 (`schwab_connections`) and are never
returned to the browser. Implementation: `worker/src/schwab.ts` +
`worker/src/schwab-http.ts` (migration `0030_schwab_connections.sql`).

Store app credentials as Worker + GitHub secrets (`deploy.yml` reinjects):

```bash
cd worker && npx wrangler secret put SCHWAB_CLIENT_ID
cd worker && npx wrangler secret put SCHWAB_CLIENT_SECRET
# optional exact callback override (must match the Schwab portal):
# cd worker && npx wrangler secret put SCHWAB_REDIRECT_URI
```

**Callback URL(s)** in the [Schwab developer portal](https://developer.schwab.com)
— HTTPS only; must match the Worker `redirect_uri` character-for-character
(lowercase `https`, no trailing slash). Multiple URLs: **comma-separated**
in one field (space-only lists break redirects):

```text
https://api.lobster.mp/api/schwab/callback,https://api-dev.lobster.mp/api/schwab/callback
```

Do **not** register `http://localhost` / `http://127.0.0.1` — Schwab rejects
non-HTTPS. Prefer testing Connect on `https://dev.lobster.mp` → `api-dev`.

**OAuth (authorization code)** — what Lobster uses today:

| Step | URL / detail |
| --- | --- |
| Authorize | `https://api.schwabapi.com/v1/oauth/authorize` — query: `client_id`, `redirect_uri`, `response_type=code`, `scope=api`, `state` (HMAC-signed) |
| Token | `POST https://api.schwabapi.com/v1/oauth/token` — `application/x-www-form-urlencoded`; `Authorization: Basic base64(client_id:client_secret)`; body `grant_type=authorization_code\|refresh_token`, `code`, `redirect_uri` |
| Auth code quirk | Callback `code` often ends with `%40` → decode to `@` before exchange |
| LMS host | Browser login/MFA runs on `https://sws-gateway.schwab.com/ui/host/#/…` (not our domain) |

**API surface:** `GET /api/schwab/status`, `GET /api/schwab/connect` (302 →
Schwab), `GET /api/schwab/callback`, `POST /api/schwab/disconnect`,
`GET /api/schwab/portfolio` (accounts + positions),
`GET /api/schwab/trades` (TRADE history ≤366 days),
`GET /api/schwab/pnl` (realized trading PnL series: MTD / YTD / 1M / 3M / 6M / 1Y).
Health reports `auth.schwab` when both secrets are present. Portfolio UI shows a
**Schwab** book tab beside suggested trades and the paper book when configured,
with Positions, Performance, and Trade history panes. User-facing copy is
`/docs/schwab-pnl`. Matching rules for implementers:

**Schwab Performance matching (internal)** — `worker/src/schwab-pnl.ts` +
`worker/src/schwab-trader.ts`. Tests:
`cd worker && node --import tsx --test test/schwab-pnl.test.ts test/schwab-trader.test.ts`.

- Chart presets and trade days are America/New_York. `dayBoundsIso` is ET
  midnight → next ET midnight − 1 ms. After-hours ISO timestamps stay on the
  ET session date.
- TRADE fetch looks back ~365 inclusive days for cost basis; 400/404 on that
  window retries the chart range and sets `lookback_truncated`. Capped
  ~3000-row responses are bisected into non-overlapping date windows; only a
  single day that still reaches the cap is fatal for P&L rather than returning
  an incomplete total.
- `normalizeTrades` skips `CURRENCY` / `USD` / `CURRENCY_*` / `feeType` rows,
  preserves every security leg in a complex execution, and allocates
  transaction fees across those legs. Missing option `symbol` is rebuilt as
  OCC from underlying + expiry + right + strike. Invalid/reversed Schwab rows
  never enter FIFO or distributions.
- Lot key: canonical OCC, else uppercased symbol / underlying, else
  `position_id` (Schwab ids often differ open vs close).
- Assignment: walk shorts chronologically; on a 100-share-round equity
  delivery within 1¢ of a short strike, insert a zero-cash BTC of that option
  before the stock leg. Puts on buy-stock, calls on sell-stock. Prefer the
  expiry closest to the delivery day. Skip ordinary `BOUGHT`/`SOLD` and
  `CLOSING` equity. Long exercise is not synthesized.
- FIFO lots are not merged (each open keeps its date). Period chart /
  `period_pnl` = lots opened on/after chart start and closed in-window.
  Older-lot closes → `prior_open_pnl` and a prior-lot fill tag. Window-scope
  `trade_count`, `closing_trade_count`, `unmatched_close_count`,
  `skipped_trade_count`. Unmatched `CLOSING` fills are counted, not invented.
- Optional `symbol=` (root ticker) filters TRADE + distributions with
  `matchesTicker` after fetch — equity symbol, `underlying`, or OCC root.
  Exact match only (`CAR` does not include `CARD`). Schwab's own `symbol=`
  query is never forwarded; it misses OCC option rows.
- Point sleeves: `daily_equity_pnl`, `daily_option_pnl`, `daily_fees` /
  `daily_equity_fees` / `daily_option_fees`, `daily_dividends`. Window
  `trades[]` are opens + closes. The UI composes the curve from include
  chips (stocks / options / dividends / fees).
- Ticker-scoped `ohlc[]` is daily candles from Schwab Market Data
  (`/pricehistory`, connected user token). `option_ohlc` remains an empty
  compatibility field: Performance does **not** fetch or mark from last-trade
  option prints (they are often stale). Legs use Black–Scholes on Schwab
  underlying closes with implied vol from the fill and Schwab quote dividend
  yield, floored at intrinsic. Assignment reclassifies delivered-stock
  intrinsic loss onto the short option; final book P&L is unchanged. Do
  **not** fall back to lake/Yahoo OHLC for portfolio marks — the lake
  often lacks the ticker or hold window (CAR Apr 2026).
- `DIVIDEND_OR_INTEREST` is a second fetch over the chart window only;
  `distributions[]` / `distributions_total` can be added to the curve
  when the Dividends chip is on.
- Admin: `GET /api/admin/schwab/pnl?user_id=` (`Bearer ADMIN_TOKEN`) plus a
  trade sample (`trade_start` / `trade_end`, `symbol`, `limit`, `trade_types`).
  Tokens never leave the Worker.

**Portal / ops gotchas (learned the hard way):**

- After **any** app edit (callbacks, products), status often returns to
  **Approved – Pending**. OAuth will not complete until **Ready for Use**
  again. Portal copy: modification review “can vary and may not be ready to
  accept traffic until after market hours.”
- Symptom while Pending / bad callback: login then loop on
  `#/login-one-step` or `#/authenticators` instead of hitting our callback.
- Enable the API products you need on the app (e.g. Accounts and Trading
  and/or Market Data Production) — missing products can look like redirect
  failures.
- Skip local HTTP callbacks; use `api-dev` for Connect QA.

**External references** (summaries only — do not mirror Schwab’s docs here):

| Link | Why it’s useful |
| --- | --- |
| [developer.schwab.com](https://developer.schwab.com) | App keys, callback registration, Ready for Use status |
| [Authenticate with OAuth (Schwab user guide)](https://developer.schwab.com/user-guides/get-started/authenticate-with-oauth) | Official three-legged OAuth / CAG overview (portal login may be required) |
| [Schwab OAuth security profile (apis.io)](https://apis.io/security/charles-schwab/charles-schwab-authentication/) | Machine-readable authorize/token URLs derived from Schwab OpenAPI |
| [schwab-py auth](https://schwab-py.readthedocs.io/en/stable/auth.html) | Community notes on exact callback matching + Pending → Ready delays |
| [Schwabdev#53](https://github.com/tylerebowers/Schwabdev/issues/53) | Real-world `#/login-one-step` loops: callback string match + API products |

### Frontend — `VITE_API_BASE`

`frontend/.env` points the frontend at the Worker:

```
# Production Pages:
VITE_API_BASE=https://api.lobster.mp

# Preview/dev Pages (set by deploy.yml during branch builds):
VITE_API_BASE=https://api-dev.lobster.mp

# Local Worker dev (wrangler dev on 127.0.0.1:8787):
# VITE_API_BASE=http://127.0.0.1:8787
# (or leave empty and use the Vite /api proxy in vite.config.ts)
```

## Run it

Open two terminals (or run the Worker in the background):

```bash
mise run worker-dev    # Cloudflare Worker on http://127.0.0.1:8787
mise run frontend       # Vite dev server on http://127.0.0.1:5173
```

Then open <http://127.0.0.1:5173>. The frontend calls the Worker (via
`VITE_API_BASE`) which queries the live Iceberg lake over R2 SQL. No local
data is needed.

### Deploy

```bash
mise run worker-deploy   # npx wrangler deploy → *.workers.dev URL
mise run loader-deploy    # npx wrangler deploy → cboe-to-r2 Worker + container
# Frontend deploys to Cloudflare Pages via the deploy.yml GitHub Action
# on push to main (project: robs-options-slop, domain: lobster.mp).
# The API Worker is on the sibling hostname api.lobster.mp (preview:
# api-dev.lobster.mp) so the Better Auth session cookie can be set on
# .lobster.mp. The loader deploys via the deploy-loader.yml GitHub Action
# (manual dispatch).
```

## API endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | `{ok:true}` |
| `GET /api/stats` | Counts of underlyings / contracts / calls / puts, last-updated timestamp |
| `GET /api/sectors` | Per-sector symbol count & avg spot price |
| `GET /api/underlyings?sector=&q=&limit=&offset=` | Paginated underlyings |
| `GET /api/symbols?q=&limit=` | Symbol autocomplete (equities/ETFs + `^VIX` indexes + `ES=F` futures; `/ES` / `/VX` roots) |
| `GET /api/screen` | The screener — see below |
| `GET /api/symbol/{symbol}` | Underlying info + option contracts (latest run), plus OHLC enrichment: ~1y of daily bars, latest 30d/90d realized-vol snapshot, recent dividends/splits. Optional staging params for the research page: `parts=ohlc` (single date-bounded OHLC query — skips underlying lookup, chain, and RV/CA/ETF enrichment), `parts=ohlc_intraday` (Yahoo 5-minute bars for the current/last session — Day chart), `parts=chain` (skip enrichment; one expiration), `expiration=YYYY-MM-DD`, `near_spot=N` (N strikes closest to spot). Default `parts=full` keeps the legacy dump. |
| `GET /api/research/{ticker}` | Ticker research brief (price/volume technicals, consolidation/accumulation, lake `options.fundamentals` latest-wins, FINRA shorting from `options.short_interest` + `options.reg_sho_daily`, earnings, and for ETFs fund profile + top holdings from `options.etf_profiles` / `options.etf_holdings`). Cached in D1 (~1h); stale rows serve immediately while a background refresh recomputes. Critical path is lake + D1 only — no live Yahoo, no OpenFIGI, no Tavily. Headlines load separately via `GET /api/news`. Filings load separately via `GET /api/research/{ticker}/filings`. Related Kalshi event markets load via `GET /api/research/{ticker}/kalshi`. Pass `?force=1` to recompute; `?chat_id=` links the chat to the security. `Server-Timing` reports `cache` vs `compute`. |
| `GET /api/research/{ticker}/filings` | SEC EDGAR filings for the ticker from `options.sec_filings` (latest-wins on `accession`). Equities return 10-K/10-Q/8-K; ETFs emphasize prospectus forms (`N-1A`, `485BPOS`, `497`, …) with `edgar_url` links. Empty list when the table is missing or the ticker has no rows yet. |
| `GET /api/research/{ticker}/kalshi` | Curated Kalshi event markets from `options.kalshi_markets` where `related_symbol` matches the ticker (SPY, TLT, BTC-USD, …). Latest-wins on `market_ticker`; live markets only; ranked by 24h volume then soonest `close_time`. Returns YES bid/ask/last (0–1), volume/OI, theme, and a Kalshi series URL. Empty when the ticker has no linked series. |
| `GET /api/research/{ticker}/earnings` | Earnings intelligence for equities: Nasdaq calendar, Yahoo reported EPS (`options.earnings_results` when provisioned, else live Yahoo), SEC companyfacts quality metrics (`options.company_facts` when provisioned, else live EDGAR XBRL — SBC, debt, NI, OCF), “what they might be hiding” flags, optional 8-K report excerpt, and an AI/notes summary cached on the research payload. Lazy-loaded on the research page. |
| `POST /api/research/warm` | Admin-only (`Bearer ADMIN_TOKEN`). Force-recompute briefs into D1 for a ticker batch (`{"tickers":["AAPL",…],"concurrency":3}`, max 40). Used by the loader `research-briefs-daily` job so `/research/{ticker}` is warm before the first visitor. |
| `GET /api/research/{ticker}/commentary` | Lobster commentary for the ticker detail page (LLM take when OpenRouter is configured, else a numbers-first synthesis from the brief). Markdown with short paragraphs and a **Trade** section — directional bias + concrete options structure when the brief has usable price/signal data. Thin briefs (no spot / no signals) return `source: "insufficient"` with a plain "Not enough data yet…" message instead of inventing a lean. Cached alongside the research payload. |
| `GET /api/research/{ticker}/chats` | Shared, titled chats linked to this security (cross-ticker graph via `security_id`). Only public shares with a title — timeline posts or enabled bot shares. Each item includes `share_id` + `title` for `/share/{id}` links. |
| `GET /api/chats/{id}/tickers` | Tickers linked to a chat (chips link to `/research/{ticker}`). |
| `GET /api/news?symbol=&limit=` | Upcoming-ish per-ticker news headlines (Worker → Tavily news search; `{title, link, published, snippet}`, cached in-isolate ~10 min). Feeds the AI Copilot's `get_news` tool — the narrative half of "why is vol high". |
| `GET /api/tables` | List lake tables (`options.*`) with columns/types, row counts, and sample rows (cached in D1; stale reads serve the cached payload while a background refresh recomputes, `?force=1` recomputes live) |
| `POST /api/query` | Run an arbitrary read-only SQL query against the lake (body: `{"sql":"...","limit":1000}`) |
| `GET /api/notebook/premium` | 45-day premium leaders notebook |
| `/agents/copilot-agent/{conversation-id}` | The Copilot chat Agent (Cloudflare Agents SDK `AIChatAgent`). The browser connects over the standard Agent WebSocket (via `useAgent`/`useAgentChat`); the conversation UUID in the path is the instance name. Unowned chats are UUID-capability; once claimed onto a user in D1 `user_chats`, the same path requires a session whose `user_id` matches. Reasoning, tool progress, SQL, results, charts, **routed multi-analyst desk viewpoints** (`publish_desk`: fundamental / technical / options / risk always, plus macro when the ask warrants it — e.g. GME options skips macro; SPY/TLT pulls macro), and the final prose stream back as typed AI SDK UI-message parts. The OpenRouter key stays in the Worker; no model key ever reaches the browser. |
| `GET/POST /api/auth/*` | Better Auth (Google OAuth). Session cookie is HttpOnly on `lobster.mp`. |
| `GET /api/me` | Signed-in profile: public `name` (product `display_name` or Google name), `display_name`, `avatar_url`, Google `image`, `handle` (null until claimed), `suggested_handle` (email/name slug, only when unset), `is_admin`, plus Copilot `reply_style` (`desk` \| `fund` \| `learner`) and optional `reply_note` (≤240 chars). 401 if anonymous. |
| `GET /api/schwab/status` | Schwab connect flag for the session (`configured` / `connected` / timestamps). No tokens. |
| `GET /api/schwab/connect` | Start Schwab OAuth (302 → Schwab LMS). Session required. |
| `GET /api/schwab/callback` | Schwab redirect; exchanges `code`, upserts D1 `schwab_connections`, 302 → `/account` or `/portfolio`. |
| `POST /api/schwab/disconnect` | Delete stored Schwab tokens for the signed-in user. |
| `GET /api/schwab/portfolio` | Signed-in Schwab book: linked accounts (masked numbers), cash / equity / buying power, and open positions from Trader API `GET /accounts?fields=positions`. Refreshes access tokens server-side. 409 if not connected; 401 if re-auth required. No tokens or account hashes in the response. |
| `GET /api/schwab/trades` | Historical TRADE transactions for a linked account (`start`/`end` YYYY-MM-DD, optional `account` + `symbol`). `symbol` matches equity and options on that root locally (Schwab's query param is not used). Caps a single query at ≤366 days. |
| `GET /api/schwab/pnl` | Realized trading PnL time series from TRADE history (`range=MTD\|YTD\|1M\|3M\|6M\|1Y`, optional `account` + `symbol`). FIFO lot matching on the America/New_York calendar; synthesizes option covers when Schwab posts assignment stock delivery without an option close (nearest expiry when several shorts share a strike); point sleeves for equity / option / fees / dividends; window `trades[]` plus closing-fill rows and `DIVIDEND_OR_INTEREST` distributions for the Portfolio Performance pane. Not an account-balance curve (excludes deposits/withdrawals). Ticker-scoped UI adds live open mark and daily paths from Schwab Market Data on the connected user token (`ohlc[]`; option legs are Black–Scholes on those stock closes, IV from the fill). Assignment moves delivered-stock intrinsic loss onto the short option so settlement does not shock net P&L. When the extended cost-basis lookback fails, `lookback_truncated: true` and the response uses the chart window only. User help: `/docs/schwab-pnl`. Matching rules: this README, Schwab Performance matching. |
| `GET /api/admin/schwab/pnl` | Admin diagnostic (`Bearer ADMIN_TOKEN`): same PnL series for `user_id=` plus a sample of trades (`trade_start`/`trade_end`, `symbol`, `limit`, `trade_types`). Tokens never leave the Worker. |
| `GET /api/portfolio` | Signed-in paper book: cash, equity, open/realized PnL, and positions (live lake marks). Optional `status=open\|closed\|all` (default `all`), `conviction=high\|medium\|low`, and `refresh=0` to skip re-marking. Auto-creates a $100k cash account on first use. Copilot also reads this book via the `get_paper_portfolio` tool. 401 if anonymous. |
| `POST /api/portfolio/track` | Open a paper position from a Copilot suggested trade (`{trade, trade_index?, chat_id?, qty?}`). Snapshots legs, marks entry from lake mid/spot, debits cash. Idempotent on `(user, suggestion_key)`. 422 if legs cannot be marked (e.g. `strike_rel` only). Interactive chat also **auto-applies** markable `suggest_trades` into the signed-in chat owner's book when the tool succeeds. |
| `POST /api/portfolio/positions/{id}/close` | Close an open position at current lake mark; credit cash and store realized PnL. |
| `PATCH /api/me` | Update profile (`{handle?}`, `{display_name?}`, `{reply_style?}`, `{reply_note?}` — at least one). Handle: 3–24 chars, letter-led lowercase alphanumerics. Display name: 1–80 chars (blank clears to Google name). Reply style is a canned audience (desk trader / hedge fund / new to trading); `reply_note` is optional flavor, 240 chars max (blank clears). Reply prefs do not require a claimed handle. 400 if invalid/reserved, 409 if handle taken. |
| `GET /api/reply-styles` | Public catalog of Copilot reply voices `{items:[{id,label,hint}], default, note_max}`. Prompt copy stays on the Worker. |
| `POST /api/me/avatar` | Upload a custom avatar (`multipart/form-data` field `avatar`, or raw image body). JPEG/PNG/WebP/SVG, ≤2 MB. Client pan/zoom-crops rasters to a square (≤512px JPEG) before upload; SVG stays vector after script screening. Stored as a D1 blob on `user_avatars`. Requires a claimed handle. Returns `{ok, name, display_name, avatar_url}`. |
| `DELETE /api/me/avatar` | Clear the custom avatar (falls back to the brand sunglasses mark). |
| `GET /api/avatars/{user_id}` | Public avatar bytes from D1 (404 when unset). |
| `GET /api/chats` | List the signed-in user's saved chats (D1 `user_chats`), newest activity first. Only rows with a non-empty title are returned — empty new-chat UUIDs never appear as "Untitled chat". 401 if anonymous. |
| `POST /api/chats/claim` | Catalog `chat_id` onto the session user **with a title** (the first user turn). Untitled claims are rejected (400) so blank shells are not cataloged. Idempotent for the owner and does **not** bump `updated_at` (opening a chat is not activity). 409 if another user already owns it. Recency is updated by a saved turn (`POST /api/chat/history`) or `PATCH` rename. |
| `POST /api/chats/fork` | Fork a public share into a **new owned chat** (`{share_id, question}`). Requires a session with a claimed public handle. Seeds the new `CopilotAgent` from the share transcript (no LLM turn), claims it onto the user with `parent_share_id` lineage, and returns `{chat_id, …}` so the client can navigate to `/chat/{id}` and send the follow-up. Later shares of the fork stamp per-turn `author` so the timeline can show who asked each question. |
| `PATCH /api/chats/{id}` | Rename a saved chat (`{title}`). |
| `DELETE /api/chats/{id}` | Soft-delete a saved chat (hidden from the list; ownership remains so the Durable Object stays locked). |
| `POST /api/chat/history` | Best-effort capture of a completed Copilot turn into the lake (`options.chat_history`). Fire-and-forget from the browser; never blocks chat. |
| `GET /api/admin/chat_history` | Admin session (or `ADMIN_TOKEN`) — newest-first transcripts from the lake. Joins `user_id` to the signed-in profile when present; anonymous rows include a visitor fingerprint from server-stamped IP + User-Agent. Optional `limit` (default 100, max 500) and `before` (`fetched_at` cursor). Holds ip/user_id — keep gated. |
| `GET /api/tool_calls` | Public Copilot tool-call debug log from D1 (no token). Defaults to failures (`ok=false`); filter with `chat_id`, `share_id`, `tool`, `ok=true\|false\|all`, `limit`, `before` (ISO). Each item has tool name, capped args, error, summary, sql, duration, turn/chat ids. `/api/admin/tool_calls` is an alias. |
| `POST /api/share/chat` | Mint a public unlisted share of a Copilot conversation (body: a full `ChatHistoryRecord`; snapshots into D1 `shared_chats`, returns `{share_id, url, can_publish, on_timeline}`). If the request has a session, the share is owned by that user so they can later list it on the timeline. |
| `GET /api/share/{id}` | Public read-only transcript — no auth: the id IS the capability (base62 of 18 random bytes); unknown/expired ids 404. Abuse columns (`created_ip`/`created_ua`) are never returned. When the share is on the timeline, the response includes `on_timeline` and `author: {handle, name, avatar_url?}`. Bot shares also include `bot_handle` / `bot: {handle, display_name, persona}`. |
| `GET /api/share/{id}/el5` | Public EL5 plain-English summary of that post (`{share_id, el5, cache_hit, computed_at, model}`). First viewer generates via OpenRouter and stores the Markdown in D1 keyed by `share_id` + source hash; later viewers are cache hits. `?force=1` regenerates. 20 generations / 10 min / IP. |
| `GET /api/timeline` | Public feed of opted-in human shares plus always-public bot shares, newest first (`?limit=`, `?before=` cursor, `?handle=` to filter one profile — human or bot). `{items, next_before, profile}` — each item includes `name`, optional `avatar_url` (custom photo path, else null / brand face), `tickers`, and optional `is_bot`; when `handle` is set, `profile` includes `name`, `avatar_url`, `created_at`, and for bots `persona`/`bio`. 404 if `handle` is set and unknown. |
| `GET /api/timeline/rail` | Desktop timeline column: trending public tags (`chat_tickers` on listed posts), breaking market headlines (Tavily), and an index tape (SPY/QQQ/IWM/DIA/^VIX 1d from `options.ohlc`). `{tags, news, highlights, fetched_at}` — section failures land as empty lists plus `news_error` / `highlights_error`, never a 500. |
| `GET /api/chats/{id}/rail` | Desktop chat companion column (same envelope as `/api/timeline/rail`, plus `chat_id`). When the chat has linked tickers, tags / related news / session tape follow those symbols; otherwise tags stay empty and news+tape fall back to the market rail. |
| `POST /api/timeline` | List a share on the public timeline (`{share_id}`). Requires a session whose user owns the share and has a claimed handle. Idempotent. A quality gate (heuristics + cheap OpenRouter moderator) rejects incomplete / cut-off / placeholder transcripts with **422** — the unlisted `/share/{id}` link is unchanged. |
| `DELETE /api/timeline/{id}` | Remove a share from the timeline. The unlisted `/share/{id}` link still works. Owner of a human listing, or any admin (admins can also unlist bot shares by clearing `bot_handle`). |
| `GET /api/bots` | Public list of enabled bot profiles (`handle`, `display_name`, `persona`, `bio`). |
| `GET /api/bots/{handle}` | Public bot profile (enabled only). |
| `GET /api/bots/{handle}/trades` | Public bot suggested-trade performance book (lake marks, open/realized PnL). Optional `status=open\|closed\|all` (default `open`), `conviction=high\|medium\|low`, and `refresh=0` to skip re-marking. Powers Suggested trades on `/portfolio` and `/u/{handle}` for bots. Copilot reads the same book via `get_bot_trades`. |
| `GET/POST /api/admin/bots` | Admin session (or `ADMIN_TOKEN`) — list / create bot profiles. |
| `GET /api/admin/copilot/capabilities` | Admin session (or `ADMIN_TOKEN`) — live Copilot system prompts + tool descriptions/JSON schemas. Optional `?schema=placeholder` (skip lake schema) and `?samples=1` (include sample rows in the Copilot prompt schema block). Powers `/copilot`. |
| `GET/PUT/DELETE /api/admin/bots/{handle}` | Admin — read (with recent runs + schedule) / update / delete a bot. |
| `POST /api/admin/bots/{handle}/generate` | Admin — mint a `chat_id` + **unique** prompt for Copilot under that persona (`{prompt?}`). Skips prompts already used on prior runs: unused seed → LLM invent. UI opens `/chat/{id}` and auto-sends. |
| `GET/PUT/DELETE /api/admin/bots/{handle}/schedule` | Admin — read / upsert / clear a recurring server-side schedule (`cadence_seconds`, `market_gated`, fixed `prompt`). |
| `POST /api/admin/bots/{handle}/schedule/trigger` | Admin — run the schedule now (`?force=1` bypasses market hours). Headless Copilot + auto-share to timeline. |
| `POST /api/admin/bots/schedules/tick` | Admin — process all due schedules (same path as the hourly Worker cron). |
| `GET /api/admin/users` | Admin session (or `ADMIN_TOKEN`) — list signed-up users (email, Google name, handle, signup time, chat count). Optional `limit` (default 500, max 2000). |
| `GET /api/admin/trades` | Admin session (or `ADMIN_TOKEN`) — flattened suggested trades from successful `suggest_trades` tool events (~30 day retention). Legs are formal (`instrument`: `option` \| `equity`, `side` buy/sell = long/short, optional `qty`; options also carry right/strike/expiry). Optional `limit` (default 100, max 500) and `before` (ISO `created_at` cursor). Enriches with newest `share_id` / `bot_handle` when the chat was shared. Powers `/trades`. |

### `/api/screen` query parameters

`symbol`, `type` (`call`|`put`), `sector`,
`min_strike`, `max_strike`, `min_volume`, `min_open_interest`,
`min_iv`, `max_iv`, `min_delta`, `max_delta`, `in_the_money`,
`expiration_before` (`YYYY-MM-DD`), `expiration_after`,
`near_spot_strikes` (default `50`),
`sort` (`volume` | `open_interest` | `strike` | `implied_vol` | `delta` | `gamma` | `theta` | `vega` | `bid` | `ask` | `last` | `expiration`),
`order` (`asc` | `desc`), `limit`, `offset`.

R2 SQL has no `OFFSET`, so the Worker fetches the ordered result set (capped
at 10,000 rows) once per filter signature, caches it, and pages slices
in-memory.

## UI features

The **timeline** is the home surface (`/`). On desktop it adds a companion
column (tags from public posts, breaking news, index tape) and hides that
rail below `56rem` until there is a mobile surface. Per-handle profiles at
`/u/{handle}` reuse the same companion column next to that author's public
chats. Chat lives at `/chat` and reuses the same companion shell inside chat
chrome (top bar spans both columns). The rail opens once tickers or session
frames attach, hosts those sources, and shows related news + session tape;
market fallback alone does not open an empty welcome rail.
**Research**
(`/research`, `/research/{ticker}`) is the ticker detail page — the brief
(spot + compact fundamentals) paints first from D1/lake; chart and Lobster
commentary arm when those sections near the viewport; the options chain is
click-to-load (one expiration + near-spot window). News, filings, related
Kalshi event markets (`related_symbol` join), and related chats settle on
idle. Chat ticker chips (from `research_ticker`) link there.
**Portfolio** (`/portfolio`) has three books: **Suggested trades** for public
bot idea PnL (same book as `/u/{handle}` — no cash), the signed-in **paper
book** (when Copilot `suggest_trades` lands concrete legs in a signed-in chat,
those ideas auto-open paper positions at lake mid; Close realizes against
$100k starting cash), and **Schwab** when OAuth is configured — live linked
brokerage accounts, balances, and positions via `GET /api/schwab/portfolio`
(connect from Account or the Schwab tab). Paper + suggested filter by status
and conviction (high / medium / low). Share/timeline viewers can still
**Add to portfolio**. Suggestions alone are not a book —
`copilot_tool_events` stays ~30d admin debug. Public bot ideas (e.g.
`@yololobster`) also remain on `/u/{handle}`
(`GET /api/bots/{handle}/trades`).
**Bots** (`/bots`, admin-only, linked from `/admin`) edit Copilot personas (handles like
`nowlobster` for live market commentary, `yololobster` for high-risk ideas)
and trigger a chat from the UI; generate picks a prompt that
has not already been used on a prior run (next unused seed, or an invented
question). Sharing stamps the post onto the public timeline under that handle.
Schedules (e.g. `@nowlobster` hourly market overview, `@yololobster` hourly
yolo scan) run headless on the Worker cron during US market hours and
auto-share without a browser; markable `suggest_trades` from those runs
feed the bot trade book on the profile.
**Admin** (`/admin`) is the left-nav hub for operator tools. **Users** (`/users`)
and **Chats** (`/chats`) are admin directories — signed-up
Google identities, and every lake Copilot conversation (profile when signed
in, visitor fingerprint from IP + UA when anonymous).
**Data**
(`/data`) is the catalog of everything that can land in an answer:

- Copilot tools (`run_query`, `research_ticker`, `get_news`, `web_search`, `eco_calendar`, frames, charts)
- Upstream feeds (CBOE delayed quotes, FRED macro calendar, Fed FOMC/Beige,
  Tavily news/search, Yahoo OHLC + ETF profiles/holdings + lake fundamentals,
  Nasdaq earnings, OpenFIGI)
- Iceberg lake tables with live row counts, columns, and sample rows
- A read-only SQL editor (`POST /api/query`) — the same path Chat uses

Only `SELECT`/`WITH`/`DESCRIBE`/`SHOW`/`EXPLAIN` are permitted. Chat deep-links
into Data with the SQL attached. Old `/lab` and `/market` URLs redirect to Data;
`/symbol/{sym}` redirects to `/research/{sym}`.

### AI Copilot

An OpenRouter-powered Copilot implemented as a Cloudflare Agents SDK
`AIChatAgent` (`CopilotAgent`, routed at `/agents/copilot-agent/{conversation-id}`).
The browser connects via `useAgent`/`useAgentChat` over the standard Agent
WebSocket and renders typed AI SDK UI-message parts: reasoning, tool feed
(streamed inputs + outputs), SQL, up to 200 result rows, chart specification,
model metadata, and the final prose answer. Chart specs are merged across tool
outputs for the turn (so `render_chart` cannot wipe the query rows the plot
needs); if the model skips `render_chart` on a chart/smile/surface question,
the client infers a spec from the result columns. Interactive analysis turns
and public bot thesis posts both publish a **routed multi-analyst desk** via
`publish_desk`: specialists are selected from fundamental / technical /
options / risk / macro based on the ask (and, for bots, the persona) — e.g. a
GME options chain keeps the core four (including risk) and skips macro; SPY /
TLT / Fed / CPI or `@macrolobster` rates posts pull macro. Risk always
publishes so every analysis turn has a downside / sizing / thesis-break take.
The UI renders only the published panels. Structured `suggest_trades`
stays interactive-chat-only unless the bot actually has a tradable idea.
Interactive chat (and the Account menu) also pick a **reply voice** — canned
audiences `desk` (working trader), `fund` (hedge-fund / PM), or `learner`
(new to trading), plus an optional 240-character note. Voice only: same Copilot
tools and desk as everyone else. Bot `system_prompt_extra` is capped at 1000
characters so timeline personas cannot dump unbounded context. The Worker owns the schema context,
deterministic SQL validation, R2 SQL execution, per-chat cached frames, chart
validation, OpenFIGI ticker research (`research_ticker`), news, web search, economic calendar, tool iteration, and the final
prose answer.

Every chat uses the site's `OPEN_ROUTER_KEY` secret with
`COPILOT_MODEL=deepseek/deepseek-v4-flash-0731` and
`COPILOT_REASONING_EFFORT=high` in `worker/wrangler.jsonc`. The key is never
accepted from or returned to browser code. `COPILOT_MAX_OUTPUT_TOKENS` caps
aggregate model output across one agent turn, while request and history
byte/character caps reject or trim runaway payloads before they consume model credit.

**Finance-only scope.** Before the agent loop runs, a cheap classifier checks
whether the latest user message is a US equities / options / macro market-data
question. Off-topic turns (shopping, lifestyle, jailbreaks, chit-chat) never
enter the model loop — the Worker seals a finished assistant turn with
`No data to answer.` (not a stream `error`, which would leave a lost-partial
user leaf and make `chatRecovery` retry forever), persists a scope lock on that
chat's Durable Object, and the UI disables the composer so follow-ups cannot
retry on the same chat. Start a new chat for a real market question. Classifier
infrastructure failures fail open so genuine market asks still work.

**Tool-loop guard.** Until a lake query succeeds, the agent forces `run_query`
(or `filter_frame` when the question names a cached frame). Bare table-less
SQL (`SELECT 1`, `SELECT 'test' AS t`) is rejected in schema validation before
it hits R2. After three failed queries in the same turn, the loop stops
forcing tools and seals a prose close-out so the model cannot burn the full
10-step budget on the same rejected probe.

**Trade liquidity.** There is no global "tradable names" filter. When the
Copilot suggests a trade it must query `options.option_contracts` for the
candidate strikes and only recommend contracts with a two-sided quote, a
tight-enough relative bid/ask, and demonstrated volume or open interest. Thin
books get a "too illiquid" close-out, not an invented fill.

**Transport & durability.** Each conversation UUID is one `CopilotAgent` Durable
Object instance with its own embedded SQLite (`storage: "sqlite"`). Chat
messages and the turn budget persist there. The live conversation is `/chat`
with the UUID in `sessionStorage` only, so a reload reconnects
`useAgentChat` (`resume: true`) to the same instance and restores the turn.
Stop detaches the browser from the live stream without cancelling the Durable
Object turn; Start (or a follow-up send) calls `resumeStream()` and continues
from the buffered chunks. Unexpected WebSocket drops are detected and retried
(PartySocket backoff plus `online` / `visibilitychange` kicks) until the
socket is back, then the same resume path reattaches. Anonymous chats stay
UUID-capability. Signing in with Google catalogs chats
that already have a user turn onto that user in D1 `user_chats` and lists them
under Chat history in the left nav; opening one navigates to `/chat/{id}` and restores
the Durable Object transcript (the Agent HTTP fetch sends the session cookie).
Empty new-chat UUIDs stay off the list until the first user turn. Later
signed-in chats inherit the owner. Once owned,
`/agents/copilot-agent/{id}` requires a matching session — the Worker never
accepts `user_id` from the client. `options.chat_history` stays admin/analytics
capture (POST `/api/chat/history` stamps `user_id` from the session when
logged in) and is not the user-facing catalog. Every tool outcome (success or
failure) is also appended server-side into D1 `copilot_tool_events` for admin
debugging via `GET /api/tool_calls` — lake history intentionally strips
tools/errors. `chatRecovery` (bounded retries; stall watchdog
`chatStreamStallTimeoutMs` tuned for multi-analyst desk gaps, with tool
status heartbeats so long `research_ticker` / lake calls do not look idle)
re-drives an interrupted answer if the Worker/Agent is evicted mid-turn, and
the client shows a "Recovering interrupted answer…" indicator. Consecutive
assistant rows from those retries are coalesced on share/timeline read and in
the live chat UI so recovery debris does not render as stacked empty bubbles. Cached result
frames live only in the Agent's SQLite (`frames`/`frame_rows`) with a 15-minute
TTL and an eight-frame cap; `filter_frame` compiles the validated expression
AST into parameterized SQLite/JSON1 predicates so a large frame is filtered
without ever loading it whole into JS. Only bounded frame metadata reaches the
client (callable `getFrameMetadata()` + tool outputs); message retention is
bounded (100 messages / 30-day cleanup).

**Sharing** — the chat header's Share button (enabled once a turn has
completed) snapshots the conversation into D1 `shared_chats` (migration 0003)
and returns a public, unlisted link `/share/<share_id>`. The `share_id` is
base62 of 18 random bytes, so the URL is the capability: anyone with the link
can view, nobody can enumerate, and a fresh incognito tab renders the
read-only transcript (user + assistant bubbles, SQL blocks) with no key or
login. From the share dialog, a signed-in author with a handle can opt the
share onto the **public timeline** (`POST /api/timeline`) — the home feed at
`/` and that author's profile page at `/u/{handle}`. Unlisted stays the default; turning the
switch off removes the listing (`DELETE /api/timeline/{id}`) without revoking
the link. Before a share is listed — human publish or bot auto-share — a
**timeline quality gate** (`worker/src/timeline-moderation.ts`) rejects cut-off
mid-tool narrations, `(see reasoning)` placeholders, and other unfinished
answers; humans get 422, bot runs mint an unlisted share without `bot_handle`
and mark the run failed. When `IMPROVEMENT_ISSUE_TOKEN` is set, a follow-up
pass (`worker/src/improvement-reporter.ts`) may open a deduped GitHub issue for
actionable product fixes (skips jailbreak/spam rejects, synthetic `test/*`
fixtures, and vague LLM-only "unfinished" fallbacks). Admins can unpublish any feed post from the timeline UI (same
DELETE): human listings drop out of `timeline_posts`, bot shares clear
`bot_handle` and leave the feed while the share URL stays live. Server-side guards: per-message trims (content ≤ 5,000 chars, sql ≤
10,000 chars), a byte budget on the serialized transcript (≤ 1.2 MB of UTF-8
bytes, oldest turns dropped first — never JS string length, which miscounts
CJK/emoji), a whole-row check against D1's 2 MB ceiling, oversized-body 413
before JSON parse, and a per-IP creation rate cap (20 / 10 min → 429).
`created_ip`/`created_ua` are captured server-side (the chat-history capture
pattern) and never served. The denormalized `source_sql` column (the last
assistant SQL) is the anchor for a future "rerun this SQL on an interval"
alerts feature — see the worker's share section for the schema rationale.

## R2 SQL / DataFusion notes

The Worker builds SQL strings for the R2 SQL REST endpoint (no parameter
binding — literals are inlined via a `lit()` helper with single-quote
escaping; sort columns are whitelisted). Key dialect constraints:

- No `OFFSET` — fetch + page in-memory
- `WHERE` must come **before** `QUALIFY`
- DTE: `CAST(expiration AS DATE) - CURRENT_DATE` (expiration is TEXT)
- `spot_price` (not `spot`) is the lake column name
- No named `WINDOW` clause; inline `OVER (...)` only
- Latest snapshot: `QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC) = 1`

## Notes / caveats

- CBOE data is delayed ~15 minutes (fine for a screener). Official exchange
  data via [cdn.cboe.com](https://cdn.cboe.com/api/global/delayed_quotes/options/) — no API key.
- **Source licensing:** EDGAR, FRED/Treasury/Fed, CBOE, Nasdaq, and FINRA are
  official and redistributable — safe to land in the lake and serve through
  `/api/query`. Yahoo-sourced data (OHLC, news RSS) is personal-use only and
  must not be re-exposed to third parties through the public query endpoint.
- The in-repo loader (`loader/`, deployed Worker `cboe-to-r2`) owns CBOE ingestion (nightly run, 610
  symbols across the S&P 500, Nasdaq-100 delta, and major ETFs including VIX ETPs and crypto ETFs,
  ~1M+ contracts), plus Yahoo OHLC for equities/ETFs/futures/indexes/spot crypto. This repo only reads the lake.
- Greeks are supplied directly by CBOE (Black-Scholes units; `theta` per
  calendar day, `vega`/`rho` per 1.00 of vol/rate).
- The Worker cache is in-isolate and tiered by how quickly the underlying data
  changes (all bounded by the nightly refresh): screener endpoints 30 min,
  `/api/query` + symbol chains 60 min
  (hash-keyed by SQL, so the chat's frame pulls and Data catalog reruns share one
  lake fetch), and the symbol typeahead reference rows 12 h. The frontend keeps
  the full symbol universe in localStorage for 24 h and searches it
  client-side, so ticker search works across browser restarts with zero lake
  queries. To force freshness sooner, redeploy the Worker (clears the isolate
  cache) or reload with cleared site storage.

## Production build

```bash
mise run build    # outputs frontend/dist
```

The `deploy.yml` GitHub Action builds and deploys the frontend to Cloudflare
Pages on push to main (`robs-options-slop` project, `lobster.mp` domain);
dev/preview deploys for non-main branches.

The text-vs-image experiment is materialized from its public API during each
frontend build. Results and exact chart PNGs ship as static assets, so the
experiment page renders without a client-side results fetch or loading state.
Its probe workflow rebuilds and redeploys that snapshot after a matrix finishes.

Each route sets its own `<title>`, description, canonical URL, and Open Graph /
Twitter tags from the path (e.g. `/research/SPY` → `SPY – Research · Lobster MP`).
The Vite build also emits a Cloudflare Pages `_worker.js` that rewrites those
tags in `index.html`, so crawlers and chat unfurlers see the right preview
without executing JavaScript. SPA deep links fall back to `index.html` inside
that worker (extensionless routes only) — there is no `public/_redirects`
catch-all, so static crawler files (`/robots.txt`, `/sitemap.xml`) stay
`text/plain` / XML instead of the app shell.
