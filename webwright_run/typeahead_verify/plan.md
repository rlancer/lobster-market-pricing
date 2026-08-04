# Critical Points — Symbol typeahead verification

Target: http://localhost:5173 (Vite dev, proxies /api -> backend:8001)
Run: final_runs/run_1  (screenshots in run_1/screenshots/, log in run_1/final_script_log.txt)

- [x] CP1: Screener view loads; Symbol control is a combobox with placeholder
  "Search ticker or name…". (step 2; screenshot 01_loaded.png)
- [x] CP2: Typing the company NAME "apple" opens a dropdown whose first item
  is "AAPL / APPLE INC. / INFORMATION TECHNOLOGY", sourced from a real
  GET /api/symbols?q=APPLE backend request. (step 4; screenshot 02_dropdown_apple.png)
- [x] CP3: ArrowDown highlights an .active item (AAPL), Enter selects it and the
  Symbol field becomes "AAPL". (steps 6-7; screenshot 03_arrowdown_active.png)
- [x] CP4: After selecting AAPL the screener table shows 100 rows, every row's
  Symbol column = AAPL. (steps 8-9; screenshot 04_table_filtered.png)
- [x] CP5: Ticker-prefix search "MSF" surfaces "MSFT / MICROSOFT" at the top.
  (step 5; screenshot 05_msf_prefix.png)
- [x] Extra: Escape closes an open dropdown. (step 10; screenshot 06_after_escape.png)

Result: ALL CRITICAL POINTS VERIFIED.
Note: the active model cannot ingest images, so verification rests on the
concrete DOM assertions + structured log (exact strings, request URL, row
counts), which are unambiguous. Screenshots are saved for human inspection.
