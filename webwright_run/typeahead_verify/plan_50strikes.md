# Critical Points — default "50 strikes around spot"

Run: final_runs/run_2  (log: run_2/final_script_log.txt, screenshots: run_2/screenshots/)

- [x] CP1: "Strikes around spot" filter control present, default value "50". (step 2)
- [x] CP2: Selecting AAPL via typeahead filters table to AAPL rows. (step 3)
- [x] CP3: API with near_spot_strikes=50 returns exactly 50 distinct strikes
  that WRAP spot (22 below, 28 above, spot=309.38) — band straddles spot. (steps 4-5)
- [x] CP4: Setting the control to 0 disables the band; table-meta total rises
  from 1211 (50 strikes) to 2817 (all 127 strikes). (step 6)

Cross-checked via curl (limit=5000, no truncation):
  omitted  -> 50 distinct / 1211 contracts   (default applied)
  =0       -> 127 distinct / 2817 contracts  (disabled)
  =10      -> 10 distinct / 252 contracts    (cap respected)

Result: ALL CRITICAL POINTS VERIFIED.
