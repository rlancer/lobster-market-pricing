"""Verify click-to-dive symbol detail + per-expiration chain grouping."""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

RUN_DIR = Path(__file__).parent
SCREENSHOTS = RUN_DIR / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
LOG = RUN_DIR / "final_script_log.txt"
LOG.write_text("")

BASE = "http://localhost:5173/"


def log(step, msg):
    line = f"step {step} action: {msg}\n"
    with LOG.open("a") as f:
        f.write(line)
    print(line, end="")


def check(cp, ok, detail=""):
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

        # CP1: screener loads with rows
        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SHOTS / "final_execution_1_screener.png"))
        n_rows = await page.locator(".screener tbody tr").count()
        log(1, f"screener loaded; rows={n_rows}")
        check("CP1", n_rows > 0)
        results["CP1"] = n_rows > 0

        # CP2: click a NVDA row -> detail view appears with underlying header
        nvda_row = page.locator(".screener tbody tr", has_text="NVDA").first
        exists = await nvda_row.count()
        if not exists:
            # filter to NVDA via symbol input
            await page.get_by_role("textbox", name="Symbol").fill("NVDA")
            await page.wait_for_timeout(1000)
            nvda_row = page.locator(".screener tbody tr", has_text="NVDA").first
        await nvda_row.click()
        await page.wait_for_timeout(1500)
        await page.screenshot(path=str(SHOTS / "final_execution_2_detail.png"))
        back_btn = await page.get_by_role("button", name="Back to screener").count()
        detail_h2 = await page.locator(".detail-title h2").inner_text()
        log(2, f"clicked NVDA; back_btn={back_btn}; title='{detail_h2.strip()}'")
        ok2 = back_btn == 1 and "NVDA" in detail_h2
        check("CP2", ok2)
        results["CP2"] = ok2

        # CP3: expirations tab selector present with multiple expirations
        exp_tabs = await page.locator(".exp-tab").count()
        exp_texts = await page.locator(".exp-tab").all_inner_texts()
        log(3, f"expiration tabs={exp_tabs}; first few={exp_texts[:4]}")
        ok3 = exp_tabs >= 2
        check("CP3", ok3)
        results["CP3"] = ok3

        # CP4: chain table rendered for the active expiration with calls/strike/puts
        chain_rows = await page.locator(".chain tbody tr").count()
        call_grp = await page.locator(".chain .call-grp").count()
        put_grp = await page.locator(".chain .put-grp").count()
        strike_cells = await page.locator(".chain .strike-cell").count()
        log(4, f"chain rows={chain_rows}; call_grp={call_grp}; put_grp={put_grp}; strike_cells={strike_cells}")
        ok4 = chain_rows > 0 and call_grp == 1 and put_grp == 1 and strike_cells > 0
        check("CP4", ok4)
        results["CP4"] = ok4

        # CP5: switching expiration regroups the chain (different strike count)
        first_meta = await page.locator(".exp-meta").inner_text()
        # click last expiration tab
        await page.locator(".exp-tab").last.click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SHOTS / "final_execution_5_exp_switch.png"))
        second_meta = await page.locator(".exp-meta").inner_text()
        second_rows = await page.locator(".chain tbody tr").count()
        log(5, f"switched expiration; first_meta='{first_meta.strip()[:80]}' second_meta='{second_meta.strip()[:80]}' second_rows={second_rows}")
        ok5 = chain_rows > 0 and second_rows > 0 and first_meta != second_meta
        check("CP5", ok5)
        results["CP5"] = ok5

        # CP6: back button returns to screener
        await page.get_by_role("button", name="Back to screener").click()
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SHOTS / "final_execution_6_back.png"))
        screener_back = await page.locator(".screener").count()
        detail_gone = await page.locator(".symbol-detail").count()
        log(6, f"back; screener={screener_back}; detail_present={detail_gone}")
        ok6 = screener_back == 1 and detail_gone == 0
        check("CP6", ok6)
        results["CP6"] = ok6

        await b.close()

    all_pass = all(results.values())
    with LOG.open("a") as f:
        f.write(f"\nALL_CRITICAL_POINTS_PASS: {all_pass}\nRESULTS: {results}\n")
    print(f"\nALL_CRITICAL_POINTS_PASS: {all_pass}\nRESULTS: {results}")
    sys.exit(0 if all_pass else 1)


SHOTS = SCREENSHOTS
asyncio.run(main())
