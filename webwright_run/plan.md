# Critical Points — Data Explorer verification

- [x] CP1: App loads at http://localhost:5173/ ; "Data Explorer" tab is visible alongside "Screener"
- [x] CP2: Clicking "Data Explorer" tab shows the explorer (sidebar with tables list + SQL editor textarea)
- [x] CP3: Sidebar lists the 3 tables (download_log, option_contracts, underlyings) with row counts
- [x] CP4: Selecting a table (e.g. option_contracts) shows its columns + types in the columns panel
- [x] CP5: Running the default sample query (#1: SELECT * FROM underlyings LIMIT 50) returns a result table with rows + row-count meta
- [x] CP6: Running a custom aggregation query returns correct columns/rows (e.g. top symbols by contract count)
- [x] CP7: A rejected (write) query shows an error message, not a crash
