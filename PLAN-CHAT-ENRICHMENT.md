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
  ~2-week window, filtered to the S&P 500 manifest. **Provisioned and live in
  production** (2026-08-09; 23 rows ingested + queryable) — see Phase 0.
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

## Phase 0 — Earnings pipeline — DONE (2026-08-09)

Provisioned with the local wrangler OAuth token — it **does** have Pipelines
write (the earlier "needs a separate token" claim was wrong; `whoami`'s scope
list just doesn't enumerate Pipelines, but create/list all worked):

1. Stream `cboe_earnings_v2` (authenticated HTTP ingest, `schemas/earnings.json`)
   — id `565156522a3a4cdab2e2b0b3693cfee6`.
2. Sink `cboe_earnings_sink` (R2 Data Catalog → created `options.earnings`;
   never pre-create the table) — id `6558635e08fb46e3b31a1d30086fbeb9`.
3. Pipeline `cboe_earnings_pipeline`: `INSERT INTO cboe_earnings_sink SELECT *
   FROM cboe_earnings_v2` — id `c7099a34df2444c791e47c985a581267`.
4. `PIPELINE_EARNINGS_URL` secret set on the `cboe-to-r2` Worker; loader
   redeployed with the `earnings-daily` job (registered, enabled, due).
5. First ingestion published directly through the pipeline (the scheduler loop
   sleeps until Monday's market open and `LOADER_TOKEN` is GitHub-only, so the
   trigger endpoint wasn't used): 23 S&P-500 rows landed for 2026-08-10..20.

**Acceptance (all verified on prod):** `/api/tables?force=1` lists `earnings`
(23 rows); R2 SQL `SELECT … FROM options.earnings` returns SPG/CSCO/WMT/TGT/
ADI/HD… with `time`, `eps_forecast`, `est_count`; a `CURRENT_DATE`-windowed
`/api/query` (the Copilot's exact pattern) returns rows. From Monday the
`earnings-daily` job keeps the ~2-week window fresh automatically (daily,
ungated; append-only + latest-wins dedupe per (symbol, earnings_date)).

> Provisioning recipe (for future tables) lives in `loader/README.md` →
> "Earnings calendar".

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

### 2a. IV rank / percentile (high value, low cost)
The lake is append-only with chain snapshots (refreshed ~15 min intraday by the
continuous loader!) → per-symbol ATM IV history exists. Today the chat can only
compare IV vs realized vol; "IV percentile 92" needs history aggregation.

**Design decision (2026-08-09): implement as a Worker endpoint, not a nightly
lake table.** The nightly approach needs new infra (R2 SQL token on the loader
+ a new Pipelines sink) — both blocked on the same Pipelines-scoped token as
Phase 0. The Worker already has lake access + the in-isolate cache, so this
works today with zero new credentials:

`GET /api/iv_rank?symbol=AAPL&days=90` → `{ symbol, days, points, rank_pct,
iv_now, iv_median, iv_min, iv_max, as_of }`.

- One pre-aggregated lake query (per-symbol, so bounded — the Copilot must
  never be told to write this):
  ```sql
  SELECT CAST(fetched_at AS DATE) AS d, approx_median(implied_vol) AS iv
  FROM options.option_contracts
  WHERE symbol = '<SYM>' AND implied_vol IS NOT NULL
    AND ABS(strike - spot_price) / NULLIF(spot_price, 0) <= 0.05
    AND CAST(fetched_at AS DATE) >= CAST(CURRENT_DATE - INTERVAL '<N>' DAY AS DATE)
  GROUP BY CAST(fetched_at AS DATE)
  ```
  The GROUP BY dedupes intraday snapshots to one ATM-IV point per day.
- `rank_pct` = fraction of the daily series ≤ `iv_now` (JS from returned rows);
  `iv_now` = latest day's median; `as_of` = latest day.
- Guards: `days` capped at 120 (default 90); near-ATM band + symbol filter
  tight; `cached()` at a 60-min TTL; lake timeout/error → 200 with
  `error` + `points: []` (same degrade-to-empty contract as `enrichSymbol`).
  Litmus: a liquid name (AAPL/NVDA) returns ~60–90 points, `rank_pct` ∈ 0..1,
  uncached ≤ ~15 s — tighten window/band if slower and say so in the PR.
- Frontend: `api.ivRank(symbol, days?)` in `frontend/src/api.ts` (types next to
  `NewsResponse`); add one line to the `systemPrompt()` Enrichment block in
  `frontend/src/ai.ts`: "IV rank vs its own 90-day history is available via the
  iv_rank endpoint — use it when the user asks if vol is rich or cheap."
  No new Copilot tool, no UI in this phase.
- **Revisit** materializing `options.iv_rank` (nightly batch, `realized_vol`
  pattern) once the Pipelines token exists — the endpoint stays as the hot path.

**Acceptance:** `/api/iv_rank?symbol=AAPL` returns a sane percentile with ~90
daily points; chat: "AAPL IV percentile 92 — expensive vs its own history and
vs 30d realized of 22%".

### 2b. One-shot `vol_context(symbol)` tool (polish)
Today the model chains IV query → realized query → earnings → news across 3–4
tool calls. A single tool returning all four in one call cuts latency and
round-trips. Optional; only if 2a lands and prompt guidance isn't enough.

---

## Phase 3 — News hardening (`worker/src/index.ts` only)

- **Feed failover**: the Yahoo ticker feed is unofficial and has been flaky
  historically. On non-200 **or** zero parsed items from
  `https://feeds.finance.yahoo.com/rss/2.0/headline?s={S}&region=US&lang=en-US`,
  retry the same symbol against `https://www.bing.com/news/search?q={S}&format=rss`
  (verified working, keyless). Response gains `source: "yahoo" | "bing"`. Both
  URLs are **env-overridable templates** (defaults above) so the fallback path
  can be exercised locally. Cache key per (symbol, source) at the existing
  10-min TTL — a failed Yahoo attempt must not poison the Bing result.
- **Relevance filtering**: the Yahoo ticker feed mixes in market-wide stories
  ("VGT Puts 39 Cents…" on the AAPL feed). Rank items: titles containing the
  symbol (case-insensitive, `.`/`-` variants) first, then by recency; when
  ticker-specific items exist, drop obvious fluff beyond the top `limit`.
- **Snippet cleanup**: strip ALL embedded HTML from descriptions, truncate to
  ~240 chars at a sentence boundary.
- Keep the degrade-to-empty contract (never 500; errors in the `error` field).

**Acceptance:** `/api/news?symbol=AAPL` returns symbol-relevant headlines with
`source:"yahoo"`; with `NEWS_YAHOO_URL_TEMPLATE` pointed at a 404 locally, the
same call returns items with `source:"bing"`; invalid symbol keeps the error
shape. Worker has no test runner — verification is `npx wrangler dev` + curl.

---

## Phase 4 — Calendar extras

- **Economic / FOMC calendar — DONE (2026-08-10, PR #66)**: FRED per-release
  `release/dates` (singular, per allowlisted `release_id`) + Fed calendar JSON →
  `options.econ_calendar` (stream `cboe_econ_v2`, sink `cboe_econ_sink`,
  pipeline `cboe_econ_pipeline`, `fred-econ-daily` job, daily ungated). The
  Worker's `/api/econ_calendar` now reads the lake's upcoming window with a
  live-fetch fallback. Historical FOMC rows (2017 → year-end) enable realized
  binary-event-impact joins against `options.ohlc`. Fed FOMC/Beige rows carry
  `event_time` (ET "HH:MM", e.g. FOMC decision 14:00, press conference 14:30)
  surfaced in `/api/econ_calendar` and the `eco_calendar` tool — the macro
  releases have no time in the FRED API, so theirs is null. The original caveat — "the
  per-symbol earnings table already covers most 'why is vol high' questions" —
  still holds for macro-context chat; the lake table's value is the *historical
  FOMC join key* the live endpoint could never provide.
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
| IV-rank endpoint scans chain history | Pre-aggregated GROUP BY, 90–120d window, near-ATM band, 60-min cache, degrade-to-empty |

## Suggested order

1. ~~**Phase 0** (unblock earnings — needs the Pipelines-scoped token)~~ — **DONE 2026-08-09**: stream/sink/pipeline provisioned, 23 rows live; `earnings-daily` auto-refreshes from Monday's market open
2. **Phase 3** (news failover + relevance — small, pure worker)
3. **Phase 2a** (IV rank — unlocks the flagship "why is vol high" answer)
4. **Phase 1** (BYOK FMP/Tavily — user-optional, bigger UI surface)
5. Phase 4/5 whenever

Everything above is free-tier; the only money spent is time.