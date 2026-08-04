# Critical Points — verify S&P 500 Options Screener (typeahead + strikes band)

Workspace: `webwright_run/handoff_verify/`
Backend: http://127.0.0.1:8001 (FastAPI + DuckDB)
Frontend: http://localhost:5173 (React + Vite, dev server)

API sanity checks already pass:
- `/api/health` -> `{"ok":true}`
- `/api/symbols?q=apple` -> `[{"symbol":"AAPL","name":"Apple Inc.","sector":"Information Technology"}]`
- default screen AAPL -> 50 distinct strikes (22 below / 28 above spot), total 1211
- `near_spot_strikes=0` -> 127 strikes, total 2817
- `near_spot_strikes=10` -> 10 strikes, total 252

## Critical Points (each independently verifiable from a screenshot and/or log line)

- [x] CP1: PASS — `combobox` role count=5 (typeahead input + 4 native `<select>`s,
      all implicit role combobox); `.first` placeholder == "Search ticker or name…".
      Evidence: log step 1; screenshot `final_execution_1_loaded.png`.
- [x] CP2: PASS — typing `apple` (auto-uppercased to `APPLE` by onChange) opened
      the dropdown; first `li.typeahead-item` inner_text =
      `AAPL\nAPPLE INC.\nINFORMATION TECHNOLOGY`; a `GET /api/symbols?q=APPLE`
      request was captured. Evidence: log step 2;
      screenshot `final_execution_2_apple_dropdown.png`.
- [x] CP3: PASS — after `ArrowDown`, `li.typeahead-item.active` count=1; `Enter`
      set combobox `input_value()` to `"AAPL"`. Evidence: log step 3;
      screenshots `final_execution_3_active_item.png`, `final_execution_3b_selected.png`.
- [x] CP4: PASS — after selecting AAPL, 100 table rows rendered and every
      `table.screener tbody tr td:first-child b` == `AAPL`.
      Evidence: log step 4; screenshot `final_execution_4_aapl_rows.png`.
- [x] CP5: PASS — typing `MSF` surfaced first item
      `MSFT\nMICROSOFT\nINFORMATION TECHNOLOGY`.
      Evidence: log step 5; screenshot `final_execution_5_msf_dropdown.png`.
- [x] CP6: PASS — strikes control is a `<select>` (idx=2 in `.filters`) with
      option values `['10','25','50','100','200','0']`, texts
      `['10','25','50','100','200','All']`, selected value `50`.
      Evidence: log step 6.
- [x] CP7: PASS — band-50 screen request URL contains `symbol=AAPL` &
      `near_spot_strikes=50`; total = 1211. Switching to `All` sent
      `near_spot_strikes=0` and total rose to 2817. Evidence: log step 7;
      screenshots `final_execution_7_band50.png`, `final_execution_7b_all.png`.
- [x] CP8: PASS — switching to `10` sent `near_spot_strikes=10` and total
      dropped to 252. Evidence: log step 8; screenshot `final_execution_8_band10.png`.
- [x] CP9: PASS — `Escape` closed the open MSF dropdown (`ul.typeahead-list`
      count 1 → 0). Evidence: log step 9; screenshot `final_execution_9_escape.png`.

## Verdict
ALL_CRITICAL_POINTS_PASS: True (9/9). Run 1 is clean; no code fixes needed.

## Ordering rationale
CP1→CP4 select AAPL and verify rows. CP6/CP7/CP8 exercise the strikes band while
AAPL stays selected. CP5 (type `MSF`) changes the symbol filter, so it is run
last; CP9 (Escape) closes the dropdown CP5 just opened.

## Note on environment quirk (not a product bug)
The Vite dev server had a cached *failed* oxc transform of `src/App.tsx` from an
earlier broken edit (logged at 5:37 PM: `PARSE_ERROR ... line 262`). The current
file (291 lines) is valid (esbuild bundles it; oxc re-transforms it cleanly), but
the stale empty module was still being served, so the app rendered as an empty
`<div id="root">`. Touching `src/App.tsx` forced a fresh re-transform (Vite logged
`page reload src/App.tsx` at 7:25), after which the app mounted and all CPs passed.
No source changes were required.
