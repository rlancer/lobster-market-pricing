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

The loader Worker (`loader/`, deployed as `cboe-to-r2`) protects its `/run`
endpoint with a bearer token. Set it once as a Worker secret:

```bash
cd loader && npx wrangler secret put LOADER_TOKEN
```

For local dev, put the same value in `loader/.dev.vars` (gitignored; see
`loader/.dev.vars.example`). Pipeline ingest URLs are **secrets** (the URL
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

### Worker — Better Auth (optional Copilot login)

Chat stays anonymous by default. Google OAuth is optional so a signed-in user
can reopen past conversations from the left nav. Sign in / Sign out live in
the app header so the account is available on every workspace page, not only
Copilot. The first sign-in asks for a public **handle** — a unique, lowercase
letters-and-numbers slug stored in D1 `user_profiles` (not on Better Auth's
`user` row). Handles are editable from the account popover and are the URL slug for
`/u/{handle}` (that handle's public posts). Chat ownership still keys off
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
| `GET /api/symbols?q=&limit=` | Symbol autocomplete |
| `GET /api/screen` | The screener — see below |
| `GET /api/symbol/{symbol}` | Underlying info + option contracts (latest run), plus OHLC enrichment: ~1y of daily bars, latest 30d/90d realized-vol snapshot, recent dividends/splits. Optional staging params for the research page: `parts=ohlc` (skip chain), `parts=chain` (skip enrichment; one expiration), `expiration=YYYY-MM-DD`, `near_spot=N` (N strikes closest to spot). Default `parts=full` keeps the legacy dump. |
| `GET /api/research/{ticker}` | Ticker research brief (price/volume technicals, consolidation/accumulation, lake `options.fundamentals` latest-wins, earnings, and for ETFs fund profile + top holdings from `options.etf_profiles` / `options.etf_holdings`). Cached in D1 (~1h); stale rows serve immediately while a background refresh recomputes. Critical path is lake + D1 only — no live Yahoo, no OpenFIGI, no Tavily. Headlines load separately via `GET /api/news`. Pass `?force=1` to recompute; `?chat_id=` links the chat to the security. `Server-Timing` reports `cache` vs `compute`. |
| `GET /api/research/{ticker}/commentary` | Lobster commentary for the ticker detail page (LLM take when OpenRouter is configured, else a numbers-first synthesis from the brief). Markdown with short paragraphs and a **Trade** section — always includes a directional bias and a concrete options structure, even when conviction is low. Cached alongside the research payload. |
| `GET /api/research/{ticker}/chats` | Chats previously linked to this security (cross-ticker graph via `security_id`). |
| `GET /api/chats/{id}/tickers` | Tickers linked to a chat (chips link to `/research/{ticker}`). |
| `GET /api/news?symbol=&limit=` | Upcoming-ish per-ticker news headlines (Worker → Tavily news search; `{title, link, published, snippet}`, cached in-isolate ~10 min). Feeds the AI Copilot's `get_news` tool — the narrative half of "why is vol high". |
| `GET /api/tables` | List lake tables (`options.*`) with columns/types, row counts, and sample rows (cached in D1; stale reads serve the cached payload while a background refresh recomputes, `?force=1` recomputes live) |
| `POST /api/query` | Run an arbitrary read-only SQL query against the lake (body: `{"sql":"...","limit":1000}`) |
| `GET /api/notebook/premium` | 45-day premium leaders notebook |
| `/agents/copilot-agent/{conversation-id}` | The Copilot chat Agent (Cloudflare Agents SDK `AIChatAgent`). The browser connects over the standard Agent WebSocket (via `useAgent`/`useAgentChat`); the conversation UUID in the path is the instance name. Unowned chats are UUID-capability; once claimed onto a user in D1 `user_chats`, the same path requires a session whose `user_id` matches. Reasoning, tool progress, SQL, results, charts, and the final prose stream back as typed AI SDK UI-message parts. The OpenRouter key stays in the Worker; no model key ever reaches the browser. |
| `GET/POST /api/auth/*` | Better Auth (Google OAuth). Session cookie is HttpOnly on `lobster.mp`. |
| `GET /api/me` | Signed-in profile: Google identity plus `handle` (null until claimed) and `suggested_handle` (email/name slug, only when unset). 401 if anonymous. |
| `PATCH /api/me` | Claim or rename handle (`{handle}`). 3–24 chars, start with a letter, lowercase letters and numbers only. 400 if invalid/reserved, 409 if taken. |
| `GET /api/chats` | List the signed-in user's saved chats (D1 `user_chats`), newest activity first. Only rows with a non-empty title are returned — empty new-chat UUIDs never appear as "Untitled chat". 401 if anonymous. |
| `POST /api/chats/claim` | Catalog `chat_id` onto the session user **with a title** (the first user turn). Untitled claims are rejected (400) so blank shells are not cataloged. Idempotent for the owner and does **not** bump `updated_at` (opening a chat is not activity). 409 if another user already owns it. Recency is updated by a saved turn (`POST /api/chat/history`) or `PATCH` rename. |
| `PATCH /api/chats/{id}` | Rename a saved chat (`{title}`). |
| `DELETE /api/chats/{id}` | Soft-delete a saved chat (hidden from the list; ownership remains so the Durable Object stays locked). |
| `POST /api/chat/history` | Best-effort capture of a completed Copilot turn into the lake (`options.chat_history`). Fire-and-forget from the browser; never blocks chat. |
| `GET /api/admin/chat_history` | Admin-only newest-first transcripts from the lake (`Bearer ADMIN_TOKEN`). Strips tools/results — content + last SQL only. Holds ip/user_id — keep gated. |
| `GET /api/tool_calls` | Public Copilot tool-call debug log from D1 (no token). Defaults to failures (`ok=false`); filter with `chat_id`, `share_id`, `tool`, `ok=true\|false\|all`, `limit`, `before` (ISO). Each item has tool name, capped args, error, summary, sql, duration, turn/chat ids. `/api/admin/tool_calls` is an alias. |
| `POST /api/share/chat` | Mint a public unlisted share of a Copilot conversation (body: a full `ChatHistoryRecord`; snapshots into D1 `shared_chats`, returns `{share_id, url, can_publish, on_timeline}`). If the request has a session, the share is owned by that user so they can later list it on the timeline. |
| `GET /api/share/{id}` | Public read-only transcript — no auth: the id IS the capability (base62 of 18 random bytes); unknown/expired ids 404. Abuse columns (`created_ip`/`created_ua`) are never returned. When the share is on the timeline, the response includes `on_timeline` and `author: {handle, name}`. |
| `GET /api/timeline` | Public feed of opted-in shares, newest first (`?limit=`, `?before=` cursor, `?handle=` to filter one profile). `{items, next_before, profile}` — each item includes `tickers` (from `chat_tickers` on the originating chat). 404 if `handle` is set and unknown. |
| `POST /api/timeline` | List a share on the public timeline (`{share_id}`). Requires a session whose user owns the share and has a claimed handle. Idempotent. |
| `DELETE /api/timeline/{id}` | Remove a share from the timeline. The unlisted `/share/{id}` link still works. Owner only. |

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

The **timeline** is the home surface (`/`). Chat lives at `/chat`. **Research**
(`/research`, `/research/{ticker}`) is the ticker detail page — the brief
(spot + compact fundamentals) paints first from D1/lake; chart and Lobster
commentary arm when those sections near the viewport; the options chain is
click-to-load (one expiration + near-spot window). News and related chats
settle on idle. Chat ticker chips (from `research_ticker`) link there. **Data**
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
the client infers a spec from the result columns. The Worker owns the schema context,
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
tools/errors. `chatRecovery` (bounded retries)
re-drives an interrupted answer if the Worker/Agent is evicted mid-turn, and
the client shows a "Recovering interrupted answer…" indicator. Cached result
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
`/` and that author's `/u/{handle}`. Unlisted stays the default; turning the
switch off removes the listing (`DELETE /api/timeline/{id}`) without revoking
the link. Server-side guards: per-message trims (content ≤ 5,000 chars, sql ≤
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
- The in-repo loader (`loader/`, deployed Worker `cboe-to-r2`) owns CBOE ingestion (nightly run, 583
  symbols across the S&P 500, Nasdaq-100 delta, and major ETFs, ~1M+ contracts). This repo only reads the lake.
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

Each route sets its own `<title>`, description, canonical URL, and Open Graph /
Twitter tags from the path (e.g. `/research/SPY` → `SPY – Research · Lobster MP`).
The Vite build also emits a Cloudflare Pages `_worker.js` that rewrites those
tags in `index.html`, so crawlers and chat unfurlers see the right preview
without executing JavaScript.
