"""Verify expiration selector is a dropdown with relative DTE labels."""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

RUN_DIR = Path(__file__).parent
SHOTS = RUN_DIR / "screenshots"
SHOTS.mkdir(parents=True, exist_ok=True)
LOG = RUN_DIR / "final_script_log.txt"
LOG.write_text("")
BASE = "http://localhost:5173/"


def log(step, msg):
    line = f"step {step} action: {msg}\n"
    with LOG.open("a") as f:
        f.write(line)
    print(line, end="")


def check(cp, ok, detail=""):
    line = f"  -> {cp}: {'PASS' if ok else 'FAIL'} {detail}\n"
    with LOG.open("a") as f:
        f.write(line)
    print(line, end="")


async def main():
    results = {}
    async with async_playwright() as p:
        b = await p.firefox.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1280, "height": 1800})
        page = await ctx.new_page()

        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(1500)
        # open NVDA detail
        nvda_row = page.locator(".screener tbody tr", has_text="NVDA").first
        if not await nvda_row.count():
            await page.get_by_role("textbox", name="Symbol").fill("NVDA")
            await page.wait_for_timeout(1000)
            nvda_row = page.locator(".screener tbody tr", has_text="NVDA").first
        await nvda_row.click()
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SHOTS / "final_execution_1_detail.png"))
        log(1, "opened NVDA detail")

        # CP1: selector is a <select>, not the old button tabs
        sel = page.locator("#exp-select")
        sel_count = await sel.count()
        old_tabs = await page.locator(".exp-tab").count()
        # native <option> children
        option_count = await sel.locator("option").count()
        log(2, f"select present={sel_count}; old exp-tab buttons={old_tabs}; options={option_count}")
        ok = sel_count == 1 and old_tabs == 0 and option_count >= 2
        check("CP1_select_is_dropdown", ok)
        results["CP1_select_is_dropdown"] = ok

        # CP2: option labels contain "DTE" relative time
        opt_texts = await sel.locator("option").all_inner_texts()
        has_dte = any("DTE" in t for t in opt_texts)
        first_opt = opt_texts[0] if opt_texts else ""
        log(3, f"first option label='{first_opt}'; any DTE={has_dte}; sample options={opt_texts[:3]}")
        ok2 = has_dte and "DTE" in first_opt
        check("CP2_options_have_DTE", ok2)
        results["CP2_options_have_DTE"] = ok2

        # CP3: DTE pill shows relative label for current selection
        pill = await page.locator(".dte-pill").inner_text()
        log(4, f"dte-pill='{pill}'")
        ok3 = "DTE" in pill or "mo" in pill or "yr" in pill or "today" in pill
        check("CP3_dte_pill_shows_relative", ok3)
        results["CP3_dte_pill_shows_relative"] = ok3

        # CP4: changing the dropdown updates the chain + pill
        await page.screenshot(path=str(SHOTS / "final_execution_4_before_change.png"))
        meta_before = await page.locator(".exp-meta").inner_text()
        before_rows = await page.locator(".chain tbody tr").count()
        # select the last option (longest DTE)
        last_val = await sel.locator("option").last.get_attribute("value")
        await sel.select_option(last_val)
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SHOTS / "final_execution_5_after_change.png"))
        meta_after = await page.locator(".exp-meta").inner_text()
        after_rows = await page.locator(".chain tbody tr").count()
        pill_after = await page.locator(".dte-pill").inner_text()
        log(5, f"changed to last exp; pill='{pill_after}'; meta_before='{meta_before.strip()[:60]}' meta_after='{meta_after.strip()[:60]}'; rows {before_rows}->{after_rows}")
        ok4 = meta_before != meta_after and "yr" in pill_after  # longest = years
        check("CP4_dropdown_updates_chain", ok4)
        results["CP4_dropdown_updates_chain"] = ok4

        await b.close()

    all_pass = all(results.values())
    with LOG.open("a") as f:
        f.write(f"\nALL_CRITICAL_POINTS_PASS: {all_pass}\nRESULTS: {results}\n")
    print(f"\nALL_CRITICAL_POINTS_PASS: {all_pass}\nRESULTS: {results}")
    sys.exit(0 if all_pass else 1)


asyncio.run(main())
