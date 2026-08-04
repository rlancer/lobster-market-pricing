# Handoff: verify S&P 500 Options Screener changes

> Paste this whole file as the first message to a **fresh pi session**.
> For screenshot-based visual verification, start that session under a
> vision-capable model, e.g. `PI_MODEL=anthropic/claude-sonnet-4.5` (or any
> `gpt-4o` / `gemini-*` vision model) via OpenRouter. A text-only model can
> still verify everything via the structured DOM/API assertions in the
> webwright run logs — vision is only needed to eyeball PNGs.

## Project

- Repo: `C:/Users/Rob/Desktop/screener_glm52`
- Backend: FastAPI + DuckDB, `mise run backend` → http://127.0.0.1:8001
- Frontend: React + Vite, `mise run frontend` → http://localhost:5173
  (Vite binds IPv6 `[::1]:5173`; use `http://localhost:5173`, **not** 127.0.0.1)
- Skills available: **webwright** (drive a local Firefox via Playwright;
  load it: read `C:\Users\Rob\.pi\agent\npm\node_modules\pi-webwright\skills\webwright\SKILL.md`).

## What was built (the 3 features to verify)

### 1. Symbol typeahead (search by company name)
- `frontend/src/SymbolTypeahead.tsx` + `.css` — accessible combobox
  (`role="combobox"`, `aria-controls`, `aria-autocomplete="list"`, listbox
  of `role="option"`), debounced 150ms, ↑/↓/Enter/Esc + outside-click.
- `backend/screener/server.py` — `/api/symbols` now returns
  `{symbol, name, sector}[]` and matches **company name** as well as ticker,
  ranked: exact > ticker prefix > ticker substring > name match.
- `frontend/src/api.ts` — `SymbolSuggestion` type; `api.symbols()` returns it.
- `frontend/src/App.tsx` — Symbol filter is now `<SymbolTypeahead>`.

### 2. Astryx design-system install (docs only — no UI migration yet)
- Installed `@astryxdesign/core`, `@astryxdesign/theme-neutral`,
  `@astryxdesign/cli` in `frontend/`.
- `npx @astryxdesign/cli init --all --agent all` generated agent docs:
  `frontend/AGENTS.md` and `frontend/.claude/CLAUDE.md` (identical except
  heading). Read them for the conventions; **no components are wired into the
  app yet** — UI still uses the original hand-written CSS.

### 3. Default "50 strikes around spot" filter
- `backend/screener/server.py` — `/api/screen` gained
  `near_spot_strikes: int | None = 50`. A CTE ranks each underlying's
  **distinct** strikes by `|strike − spot|` and keeps the closest N, applied
  to both count and data queries (so `total` stays consistent). `0` disables
  → all strikes; omitted → default 50. Underlyings with fewer than N strikes
  keep all of them.
- `frontend/src/App.tsx` — new filter `nearSpot`, now a **`<select>`** with
  preset options: **10 / 25 / 50 (default) / 100 / 200 / All (value "0")**.
  Reset restores 50. The client sends an explicit `0` (not `undefined`) so
  "All" reaches the backend instead of being shadowed by its default-50.

## Before you verify — start the servers

```bash
cd /c/Users/Rob/Desktop/screener_glm52
# kill stale backend by PID (NEVER taskkill //IM node.exe or python.exe)
pid=$(netstat -ano | grep LISTENING | grep ":8001 " | awk '{print $5}' | head -1)
[ -n "$pid" ] && taskkill //F //PID "$pid"
nohup mise run backend > /tmp/backend.log 2>&1 & sleep 6
curl -s http://127.0.0.1:8001/api/health        # -> {"ok":true}
# frontend (separate terminal if you want logs, or also background it)
nohup mise run frontend > /tmp/frontend.log 2>&1 & sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/   # -> 200
```

## Quick API sanity checks (do these first)

```bash
# name search works (company name -> ticker)
curl -s "http://127.0.0.1:8001/api/symbols?q=apple"
# -> [{"symbol":"AAPL","name":"Apple Inc.","sector":"Information Technology"}]

# strikes band: default omitted -> 50 distinct strikes wrapping spot
curl -s "http://127.0.0.1:8001/api/screen?symbol=AAPL&sort=strike&order=asc&limit=5000" \
  | python -c "import sys,json;d=json.load(sys.stdin);s=sorted({r['strike'] for r in d['items']});sp=d['items'][0]['spot'];print('strikes',len(s),'below',sum(1 for x in s if x<sp),'above',sum(1 for x in s if x>sp))"
# -> strikes 50  below 22  above 28   (50, straddling spot)

# =0 disables -> all strikes
curl -s "http://127.0.0.1:8001/api/screen?symbol=AAPL&near_spot_strikes=0&sort=strike&order=asc&limit=5000" \
  | python -c "import sys,json;d=json.load(sys.stdin);print('strikes',len({r['strike'] for r in d['items']}))"
# -> strikes 127

# =10 caps to 10 distinct strikes
curl -s "http://127.0.0.1:8001/api/screen?symbol=AAPL&near_spot_strikes=10&sort=strike&order=asc&limit=5000" \
  | python -c "import sys,json;d=json.load(sys.stdin);print('strikes',len({r['strike'] for r in d['items']}))"
# -> strikes 10
```

## Browser verification with the webwright skill

Load the skill, then author a Playwright script (Firefox headless,
`viewport={"width":1280,"height":1800}`, **never** `full_page=True`) under
`webwright_run/handoff_verify/final_runs/run_1/final_script.py` with a
matching `plan.md`. Set `sys.stdout.reconfigure(encoding="utf-8")` first —
the UI renders Greek letters (Γ Δ Θ ν) that crash Windows cp1252 console.

### plan.md — critical points to tick off

- [ ] CP1: Screener loads; Symbol control is a `role="combobox"` input with
      placeholder `"Search ticker or name…"`.
- [ ] CP2: Typing the **company name** `apple` opens a dropdown whose first
      `li.typeahead-item` reads `AAPL / APPLE INC. / INFORMATION TECHNOLOGY`,
      and a `GET /api/symbols?q=APPLE` request fired (check `page.on("request")`).
- [ ] CP3: `ArrowDown` adds class `active` to an item; `Enter` selects it and
      the combobox `input_value()` becomes `"AAPL"`.
- [ ] CP4: After selecting AAPL, every visible screener table row's first
      cell equals `AAPL`.
- [ ] CP5: Ticker-prefix search `MSF` surfaces `MSFT / MICROSOFT` as the
      first item.
- [ ] CP6: The "Strikes around spot" control is a **`<select>`** (not a
      number input) with options `10/25/50/100/200/All`, defaulted to `50`.
- [ ] CP7: With AAPL selected and band=50, `GET /api/screen` carries
      `near_spot_strikes=50`; switching the select to `All` sends
      `near_spot_strikes=0` and the `.table-meta` total rises
      (1211 → 2817 contracts for AAPL).
- [ ] CP8: Switching the select to `10` sends `near_spot_strikes=10` and the
      `.table-meta` total drops (to 252 for AAPL).
- [ ] CP9: `Escape` closes an open dropdown (`ul.typeahead-list` count → 0).

### Reference selectors (already proven to work)
- combobox: `pg.get_by_role("combobox").first`
- dropdown items: `ul.typeahead-list li.typeahead-item`
- active item: `ul.typeahead-list li.typeahead-item.active`
- strikes select: it's the `<select>` inside the `.filters` whose first
  `<option>` text is `10`; or grab all selects and pick the one whose option
  values include `"50"` and `"0"`.
- table rows: `table.screener tbody tr`; total is in `.table-meta`
  (text `Showing <n> of <total> matching contracts`).

### Naming / log contract (from the skill)
- screenshots: `screenshots/final_execution_<step>_<action>.png`
- one `step <n> action: <reason>` line per CP-relevant interaction in
  `final_script_log.txt`; print the final verdict at the end.
- assert each CP with concrete DOM/text/evidence — don't guess from a
  screenshot alone (and you can't, if the model isn't vision-capable).

## Expected verdict

All 9 CPs pass. If any fails, diagnose specifically (wrong param sent, select
missing, band not wrapping spot, total not changing) and either fix the code
in `frontend/src/App.tsx` or `backend/screener/server.py` (rebuild frontend
with `cd frontend && npm run build`; restart backend by PID on port 8001),
then re-run in `final_runs/run_2/`.

## Files touched (for reference)
- `backend/screener/server.py` — `/api/symbols` + `/api/screen`
- `frontend/src/api.ts` — `SymbolSuggestion`, `api.symbols()`
- `frontend/src/SymbolTypeahead.tsx` + `.css` (new)
- `frontend/src/App.tsx` — typeahead + `nearSpot` `<select>`
- `frontend/package.json` — Astryx deps
- `frontend/AGENTS.md`, `frontend/.claude/CLAUDE.md` — Astryx agent docs
- Prior webwright runs: `webwright_run/typeahead_verify/final_runs/run_1`
  (typeahead) and `.../run_2` (50-strikes) — logs/screenshots already there.
