"""Verify the Data Explorer tab: browse tables, run SQL, handle errors.
Saves screenshots + an action log; asserts each critical point via DOM text."""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

RUN_DIR = Path(__file__).parent
SCREENSHOTS = RUN_DIR / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
LOG = RUN_DIR / "final_script_log.txt"
LOG.write_text("")  # reset

BASE = "http://localhost:5173/"


def log(step: int, msg: str) -> None:
    line = f"step {step} action: {msg}\n"
    with LOG.open("a") as f:
        f.write(line)
    print(line, end="")


def check(cp: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    line = f"  -> {cp}: {status} {detail}\n"
    with LOG.open("a") as f:
        f.write(line)
    print(line, end="")


async def main():
    results = {}
    async with async_playwright() as p:
        b = await p.firefox.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1280, "height": 1800})
        page = await ctx.new_page()

        # ---- CP1: load + tabs present ----
        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_1_loaded.png"))
        tabs = await page.get_by_role("navigation").get_by_role("button").all_inner_texts()
        has_explorer = "Data Explorer" in tabs and "Screener" in tabs
        log(1, "open app; tabs visible: " + ", ".join(tabs))
        check("CP1", has_explorer, f"tabs={tabs}")
        results["CP1"] = has_explorer

        # ---- CP2: click Data Explorer tab ----
        await page.get_by_role("button", name="Data Explorer").click()
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_2_explorer.png"))
        editor_visible = await page.get_by_role("textbox").count()  # textarea + maybe inputs
        # the SQL editor textarea is the big one; sidebar heading "Tables" present
        tables_heading = await page.get_by_role("heading", name="Tables").count()
        # tables listed in the sidebar
        table_btns = await page.locator(".table-list .table-btn").count()
        log(2, f"switch to Data Explorer; Tables heading={tables_heading}, table rows={table_btns}, textboxes={editor_visible}")
        check("CP2", tables_heading == 1 and table_btns >= 1 and editor_visible >= 1)
        results["CP2"] = tables_heading == 1 and table_btns >= 1

        # ---- CP3: 3 tables with row counts ----
        names = await page.locator(".table-list .table-name").all_inner_texts()
        counts = await page.locator(".table-list .table-count").all_inner_texts()
        log(3, f"tables: {list(zip(names, counts))}")
        expected = {"download_log", "option_contracts", "underlyings"}
        got = set(names)
        ok3 = expected.issubset(got) and all(c.strip() not in ("", "?") for c in counts)
        check("CP3", ok3, f"names={names} counts={counts}")
        results["CP3"] = ok3

        # ---- CP4: select option_contracts -> columns panel shows columns+types ----
        # click the table button by name
        await page.locator(".table-list .table-btn", has_text="option_contracts").click()
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_3_table_cols.png"))
        col_names = await page.locator(".column-list .col-name").all_inner_texts()
        col_types = await page.locator(".column-list .col-type").all_inner_texts()
        has_cols = len(col_names) >= 5 and any("strike" in c.lower() for c in col_names)
        has_types = any(t.strip() for t in col_types)
        log(4, f"option_contracts columns: {list(zip(col_names, col_types))}")
        check("CP4", has_cols and has_types, f"n_cols={len(col_names)}")
        results["CP4"] = has_cols and has_types

        # ---- CP5: run default sample query #1 (SELECT * FROM underlyings LIMIT 50) ----
        await page.get_by_role("button", name="Data Explorer").click()  # ensure on explorer
        # set the editor to the sample
        editor = page.locator(".sql-editor")
        await editor.fill("SELECT * FROM underlyings LIMIT 50")
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_4_before_run.png"))
        await page.get_by_role("button", name="Run ▸").click()
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_5_sample_result.png"))
        meta = await page.locator(".result-meta").inner_text()
        result_rows = await page.locator(".result-table tbody tr").count()
        result_cols = await page.locator(".result-table thead th").count() - 1  # minus idx col
        ok5 = result_rows > 0 and "rows" in meta and result_cols > 0
        log(5, f"sample query run; meta='{meta.strip()}' rows={result_rows} cols={result_cols}")
        check("CP5", ok5)
        results["CP5"] = ok5

        # ---- CP6: custom aggregation -> top symbols by contract count ----
        await editor.fill(
            "SELECT symbol, COUNT(*) AS n FROM option_contracts GROUP BY 1 ORDER BY 2 DESC LIMIT 5"
        )
        await page.get_by_role("button", name="Run ▸").click()
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_6_agg_result.png"))
        headers = await page.locator(".result-table thead th").all_inner_texts()
        first_row_cells = await page.locator(".result-table tbody tr").first.locator("td").all_inner_texts()
        meta6 = await page.locator(".result-meta").inner_text()
        has_sym_col = "symbol" in [h.strip().lower() for h in headers if h.strip() != "#"]
        ok6 = has_sym_col and len(first_row_cells) >= 2 and "5 rows" in meta6
        log(6, f"agg query; headers={headers} first_row={first_row_cells} meta='{meta6.strip()}'")
        check("CP6", ok6, f"first_row={first_row_cells}")
        results["CP6"] = ok6

        # ---- CP7: rejected write query shows error, no crash ----
        await editor.fill("DROP TABLE underlyings")
        await page.get_by_role("button", name="Run ▸").click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_7_error.png"))
        meta7 = await page.locator(".result-meta").inner_text()
        ok7 = "error" in meta7.lower() and "read-only" in meta7.lower()
        log(7, f"rejected query; meta='{meta7.strip()}'")
        check("CP7", ok7)
        results["CP7"] = ok7

        await b.close()

    all_pass = all(results.values())
    with LOG.open("a") as f:
        f.write(f"\nALL_CRITICAL_POINTS_PASS: {all_pass}\n")
        f.write(f"RESULTS: {results}\n")
    print(f"\nALL_CRITICAL_POINTS_PASS: {all_pass}")
    print(f"RESULTS: {results}")
    sys.exit(0 if all_pass else 1)


asyncio.run(main())
