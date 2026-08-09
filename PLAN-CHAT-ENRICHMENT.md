# Chat Enrichment — Plan & Next Steps

Follow-on to the **earnings + news enrichment** work (PR #39) that gave the AI
Copilot a narrative half for "why is vol high / why is this moving?". This file
is the forward plan: what shipped, what's blocked, and the ranked next steps
with concrete design, file touchpoints, and acceptance criteria.

Grounding: the Copilot is a client-side BYOK OpenRouter agent with tools
(`frontend/src/ai.ts`: `run_query`, `check_schema`, `list_frames`,
`filter_frame`, `refresh_frame`, `render_chart`, `get_news`). Lake tables
auto-surface in its schema prompt via `/api/tables` (`worker/src/index.ts`), so
new tables need **zero Copilot wiring**. Batch data lands via the loader
(`loader/src/jobs/`, registry in `jobs/registry.ts`, Pipeline → Iceberg).

---

## Status of the shipped slice (PR #39)

- [x] **Earnings calendar → `options.earnings`** — `loader/src/earnings.ts` +
  `jobs/earnings-daily.ts` + `schemas/earnings.json` + tests + probe
  (`tools/earnings_probe.ts`). Source: Nasdaq calendar API (keyless, browser-UA),
  ~2-week window, filtered to the S&P 500 manifest. **Dry-runs until the
  pipeline exists** — provisioning is Phase 0 below.
- [x] **News → `GET /api/news`** — `worker/src/index.ts`: Yahoo Finance ticker
  RSS proxied server-side (keyless), stripped to `{title, link, published,
  snippet}`, 10-min in-isolate cache, degrade-to-empty on upstream failure.
  Verified live (local dev + deployed preview).
- [x] **Copilot `get_news` tool + prompt guidance** — `frontend/src/ai.ts`,
  `api.ts`, `AiChat.tsx` (example card). Model is told to answer "why is vol
  high" in three parts: IV vs `options.realized_vol` → `options.earnings`
  proximity → `get_news` narrative.
- [x] **Dividends/splits history** already in the lake (`options.corporate_actions`,
  Yahoo events block, ongoing OHLC job) — the Copilot can query them today.
- Verified: loader 65 tests (live-capture fixtures), live earnings probe against
  the real Nasdaq endpoint, `/api/news` exercised locally, frontend build/lint +
  worker tsc clean, previews HTTP 200.

---

## Phase 0 — Provision the earnings pipeline (the only blocker; do this first)

The job, schema, and tests are done; **no data flows** until the stream/sink/table
exist and the secret is set. The local wrangler OAuth token has no Pipelines
scope, so this needs an account token with **Workers Pipelines write** (+ R2
Data Catalog write for the sink).

1. Create stream `cboe_earnings_v2` with `loader/schemas/earnings.json`.
2. Create sink `cboe_earnings_sink` (sink creates `options.earnings` — never
   pre-create the Iceberg table; see `loader/AGENTS.md`).
3. Wire pipeline stream → sink; store ingest URL as Worker secret
   `PIPELINE_EARNINGS_URL` (`cd loader && npx wrangler secret put PIPELINE_EARNINGS_URL`).
4. Trigger once: `POST /jobs/earnings-daily/trigger` (Bearer `LOADER_TOKEN`).

**Acceptance:** `GET /api/tables?force=1` lists `options.earnings`; R2 SQL
`SELECT COUNT(*) FROM options.earnings` > 0; Copilot "does NVDA report this
week?" returns rows; `/jobs/earnings-daily` shows a successful `last_pass`.

Exact command checklist lives in `loader/README.md` → "Earnings calendar".

---

## Phase 1 — BYOK Tier 2 (user-owned keys, consistent with OpenRouter)

The app already runs BYOK (OpenRouter key in localStorage, sent browser-direct).
The next data tier follows the same philosophy but needs a **worker passthrough**:
FMP and Tavily don't send browser CORS headers (unlike OpenRouter), so the key
rides a request header to a worker endpoint that forwards and **never stores it**.

### 1a. FMP key (250 req/day free) — one key covers several gaps
- **Earnings depth**: revenue forecasts, surprise history, guidance — joins the
  Nasdaq rows in `options.earnings`.
- **Forward-looking dividends**: next ex-date/amount per symbol (currently only
  history is in `options.corporate_actions`).
- **News fallback**: if Yahoo RSS degrades (it's unofficial).

Touchpoints: `worker/src/index.ts` (generic `/api/byok?provider=fmp&path=…`
forwarder with an optional per-call cache), `frontend/src/ai.ts` (tools like
`earnings_detail(symbol)`, `dividend_forecast(symbol)`), `frontend/src/ai.ts`
key storage + settings UI. New Copilot tools are opt-in per key.

**Acceptance:** chat answers include revenue estimates + next ex-dividend
amount/date; answer cites FMP as source; no key ever touches server storage.

### 1b. Tavily (1,000 credits/mo free) — real web search
- `web_search(query, max_results)` tool: actually searches the web instead of
  one symbol's feed; "why is vol high" becomes "what are analysts saying".
- Same BYOK + worker-forward pattern; verify CORS first (if Tavily ever sends
  `Access-Control-Allow-Origin: *`, go browser-direct like OpenRouter).
- Cheap guard: cap results (5) and snippet length; user's own quota.

**Acceptance:** "what's driving NVDA this week?" returns cited search results,
not just the RSS feed.

---

## Phase 2 — Vol analytics from data we already have (no new sources)

### 2a. IV rank / percentile table (high value, low cost)
The lake is append-only with nightly chain snapshots → per-symbol ATM IV history
exists. Today the chat can only compare IV vs realized vol; "IV percentile 92"
needs history aggregation.

- Nightly batch DO job (mirror `realized_vol` pipeline): aggregate ATM IV per
  symbol per snapshot, compute 1y percentile/rank of current IV → small table
  `options.iv_rank` (symbol, rank_pct, iv_now, iv_median, n_days, run_id, fetched_at).
- Do **not** do this on-demand via `/api/query` — window functions over the
  full chain history are budget-gated and slow.

**Acceptance:** `options.iv_rank` exists; chat: "AAPL IV percentile 92 —
expensive vs its own history and vs 30d realized of 22%".

### 2b. One-shot `vol_context(symbol)` tool (polish)
Today the model chains IV query → realized query → earnings → news across 3–4
tool calls. A single tool returning all four in one call cuts latency and
round-trips. Optional; only if 2a lands and prompt guidance isn't enough.

---

## Phase 3 — News hardening

- **Feed failover**: Yahoo RSS is unofficial and has been flaky historically.
  Bing News RSS is verified working — worker falls back to it when Yahoo 4xx/5xx
  (or parse yields zero items).
- **Relevance filtering**: the Yahoo ticker feed mixes in market-wide stories
  ("VGT Puts 39 Cents…" on the AAPL feed). Heuristic: rank items by recency and
  prefer titles mentioning the symbol; keep the rest as context only if short.
- **Snippet cleanup**: descriptions carry embedded HTML; strip more aggressively
  or truncate at sentence boundary.

**Acceptance:** `/api/news?symbol=AAPL` returns symbol-relevant headlines even if
Yahoo's feed is down (Bing fallback path covered by a worker test/probe).

---

## Phase 4 — Calendar extras (defer; lower ROI)

- **Economic / FOMC calendar**: FRED `release/dates` API (official, free key,
  no cost) → `options.econ_calendar` or a worker endpoint; flags binary-event
  weeks (FOMC, CPI) that lift broad vol. Nice macro context, but the per-symbol
  earnings table already covers most "why is vol high" questions.
- **Forward-looking dividends**: covered by Phase 1a (FMP) — do not build from
  Yahoo (crumb-locked, verified dead 2026-08-08).
- **Madness-check: unusual-activity feeds (Unusual Whales, FlowAlgo)** are paid
  and not worth it; volume/OI deltas from our own nightly snapshots are free.

---

## Phase 5 — UX / prompt polish

- Example cards: "Which names report this week with the richest IV?", "Show
  earnings-adjacent vol for MSFT".
- Earning-day answer format guidance: date + time (pre/after) + EPS est + count
  of estimates + IV vs realized — the model already has all inputs.
- Add per-table descriptions to `schemaToPrompt` (`frontend/src/ai.ts`) — today
  the model infers semantics from column names + samples only; one-line table
  comments (e.g. "options.earnings: upcoming S&P 500 earnings; time = pre-market
  / after-hours / null") would make discovery more reliable.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Nasdaq calendar is unofficial/undocumented | Bounded retries, per-date failure isolation, dry-run until ready; FMP (1a) as upgrade path |
| Yahoo RSS unofficial / can 404 | Bing RSS failover (Phase 3); FMP news as last resort |
| BYOK worker passthrough surfaces user keys in logs | Never log headers; keys live only in request headers + localStorage; document in settings UI |
| FMP/Tavily free-tier quotas changed | Both confirmed current (2026-08-08): FMP 250 req/day, Tavily 1,000 credits/mo |
| IV-rank job scans large chain history | Nightly batch, bounded window (e.g. 260 snapshots), one small table out |

## Suggested order

1. **Phase 0** (unblock earnings — needs the Pipelines-scoped token)
2. **Phase 3** (news failover + relevance — small, pure worker)
3. **Phase 2a** (IV rank — unlocks the flagship "why is vol high" answer)
4. **Phase 1** (BYOK FMP/Tavily — user-optional, bigger UI surface)
5. Phase 4/5 whenever

Everything above is free-tier; the only money spent is time.