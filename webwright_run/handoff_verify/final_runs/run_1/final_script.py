"""Verify the S&P 500 Options Screener: symbol typeahead + strikes-around-spot band.

Drives a headless Firefox through http://localhost:5173, asserts each critical
point in plan.md via concrete DOM/text/network evidence, saves a screenshot per
CP, and prints the final verdict. Greek glyphs (Γ Δ Θ ν) in the table would
crash the Windows cp1252 console, so force UTF-8 stdout first.
"""
import asyncio
import re
import sys
from pathlib import Path
from playwright.async_api import async_playwright

# --- UTF-8 console (Greek letters in the UI) ---
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

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


def parse_total(meta_text: str) -> int:
    # "Showing 100 of 1,211 matching contracts · sorted by volume (desc)"
    m = re.search(r"of\s+([\d,]+)\s+matching", meta_text)
    return int(m.group(1).replace(",", "")) if m else -1


async def main():
    results = {}
    # capture network requests
    requests: list[str] = []

    async with async_playwright() as p:
        b = await p.firefox.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1280, "height": 1800})
        page = await ctx.new_page()
        page.on("request", lambda req: requests.append(req.url))

        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_1_loaded.png"))

        # ---- CP1: screener loads; Symbol control is role=combobox with placeholder ----
        combo = page.get_by_role("combobox").first
        combo_count = await page.get_by_role("combobox").count()
        placeholder = await combo.get_attribute("placeholder") if combo_count else None
        ok1 = combo_count >= 1 and placeholder == "Search ticker or name…"
        log(1, f"open app; combobox count={combo_count} placeholder={placeholder!r}")
        check("CP1", ok1, f"placeholder={placeholder!r}")
        results["CP1"] = ok1

        # ---- CP2: type company name "apple" -> dropdown opens, first item AAPL/Apple/sector ----
        await combo.click()
        await combo.fill("apple")
        # dropdown search is debounced 150ms + network; wait for first item
        await page.locator("ul.typeahead-list li.typeahead-item").first.wait_for(
            state="visible", timeout=5000
        )
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_2_apple_dropdown.png"))
        first_item = page.locator("ul.typeahead-list li.typeahead-item").first
        item_text = (await first_item.inner_text()).upper()
        sym_req = any("/api/symbols?q=APPLE" in u for u in requests)
        ok2 = ("AAPL" in item_text) and ("APPLE" in item_text) and (
            "INFORMATION TECHNOLOGY" in item_text
        ) and sym_req
        log(2, f"type 'apple'; first_item={item_text!r} symbols_req={sym_req}")
        check("CP2", ok2, f"first_item={item_text!r} req={sym_req}")
        results["CP2"] = ok2

        # ---- CP3: ArrowDown -> active item; Enter -> combobox value becomes AAPL ----
        await combo.press("ArrowDown")
        await page.wait_for_timeout(150)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_3_active_item.png"))
        active_count = await page.locator(
            "ul.typeahead-list li.typeahead-item.active"
        ).count()
        active_text = ""
        if active_count:
            active_text = (await page.locator(
                "ul.typeahead-list li.typeahead-item.active"
            ).first.inner_text()).upper()
        await combo.press("Enter")
        await page.wait_for_timeout(400)
        input_value = await combo.input_value()
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_3b_selected.png"))
        ok3 = active_count >= 1 and "AAPL" in active_text and input_value == "AAPL"
        log(3, f"ArrowDown; active_count={active_count} active_text={active_text!r} "
              f"after Enter input_value={input_value!r}")
        check("CP3", ok3, f"active={active_count} value={input_value!r}")
        results["CP3"] = ok3

        # ---- CP4: every visible screener row first cell == AAPL ----
        await page.locator("table.screener tbody tr").first.wait_for(
            state="visible", timeout=8000
        )
        await page.wait_for_timeout(800)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_4_aapl_rows.png"))
        row_count = await page.locator("table.screener tbody tr").count()
        first_cells = await page.locator(
            "table.screener tbody tr td:first-child b"
        ).all_inner_texts()
        all_aapl = row_count > 0 and all(c.strip() == "AAPL" for c in first_cells)
        log(4, f"rows={row_count} first_cells_unique={sorted(set(first_cells))}")
        check("CP4", all_aapl, f"rows={row_count} unique_syms={sorted(set(first_cells))}")
        results["CP4"] = all_aapl

        # ---- CP6: strikes-around-spot is a <select> 10/25/50/100/200/All default 50 ----
        # find the select whose option values include 50 and 0
        selects = page.locator(".filters select")
        n_selects = await selects.count()
        strikes_idx = None
        for i in range(n_selects):
            vals = await selects.nth(i).locator("option").evaluate_all(
                "els => els.map(e => e.value)"
            )
            if "50" in vals and "0" in vals and "10" in vals and "200" in vals:
                strikes_idx = i
                break
        ok6 = False
        if strikes_idx is not None:
            strikes_sel = selects.nth(strikes_idx)
            tag = await strikes_sel.evaluate("el => el.tagName")
            opt_vals = await strikes_sel.locator("option").evaluate_all(
                "els => els.map(e => e.value)"
            )
            opt_texts = await strikes_sel.locator("option").evaluate_all(
                "els => els.map(e => e.textContent.trim())"
            )
            selected_val = await strikes_sel.evaluate("el => el.value")
            ok6 = (
                tag == "SELECT"
                and opt_vals == ["10", "25", "50", "100", "200", "0"]
                and opt_texts == ["10", "25", "50", "100", "200", "All"]
                and selected_val == "50"
            )
            log(6, f"strikes select idx={strikes_idx} tag={tag} vals={opt_vals} "
                  f"texts={opt_texts} selected={selected_val}")
        else:
            log(6, "strikes select NOT FOUND among .filters select")
        check("CP6", ok6)
        results["CP6"] = ok6

        # helper: latest /api/screen request URL after a marker
        def latest_screen(after: int) -> str:
            for u in reversed(requests[after:]):
                if "/api/screen" in u:
                    return u
            return ""

        # ---- CP7: band=50 carries near_spot_strikes=50; All -> 0 and total rises ----
        # ensure a screen for AAPL band 50 has been captured
        await page.wait_for_timeout(600)
        marker0 = len(requests)
        # trigger a fresh screen by clicking the Screen button (exact name; the
        # "Screener" tab would otherwise also match a substring search)
        await page.get_by_role("button", name="Screen", exact=True).click()
        await page.wait_for_timeout(1500)
        screen_50 = latest_screen(marker0)
        # fall back to any already-fired AAPL band-50 screen if the click race lost it
        if not ("near_spot_strikes=50" in screen_50 and "symbol=AAPL" in screen_50):
            for u in requests:
                if "/api/screen" in u and "symbol=AAPL" in u and "near_spot_strikes=50" in u:
                    screen_50 = u
                    break
        meta = await page.locator(".table-meta").inner_text()
        total_50 = parse_total(meta)
        has_50 = "near_spot_strikes=50" in screen_50 and "symbol=AAPL" in screen_50
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_7_band50.png"))
        log(7, f"band50 screen_req={screen_50!r} total={total_50}")

        # switch strikes select to "All" (value 0)
        marker1 = len(requests)
        await selects.nth(strikes_idx).select_option("0")
        await page.wait_for_timeout(1500)
        screen_all = latest_screen(marker1)
        meta_all = await page.locator(".table-meta").inner_text()
        total_all = parse_total(meta_all)
        has_0 = "near_spot_strikes=0" in screen_all
        rose = total_all > total_50
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_7b_all.png"))
        ok7 = has_50 and has_0 and rose
        log(7, f"All screen_req={screen_all!r} total={total_all} rose={rose} "
              f"({total_50} -> {total_all})")
        check("CP7", ok7, f"50:{has_50} all:{has_0} {total_50}->{total_all}")
        results["CP7"] = ok7

        # ---- CP8: switch to 10 -> near_spot_strikes=10, total drops to 252 ----
        marker2 = len(requests)
        await selects.nth(strikes_idx).select_option("10")
        await page.wait_for_timeout(1500)
        screen_10 = latest_screen(marker2)
        meta_10 = await page.locator(".table-meta").inner_text()
        total_10 = parse_total(meta_10)
        has_10 = "near_spot_strikes=10" in screen_10
        dropped = total_10 < total_all
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_8_band10.png"))
        ok8 = has_10 and dropped
        log(8, f"10 screen_req={screen_10!r} total={total_10} dropped={dropped} "
              f"({total_all} -> {total_10})")
        check("CP8", ok8, f"10:{has_10} {total_all}->{total_10}")
        results["CP8"] = ok8

        # ---- CP5: ticker-prefix MSF -> first item MSFT/Microsoft ----
        await combo.click()
        await combo.fill("msf")
        await page.locator("ul.typeahead-list li.typeahead-item").first.wait_for(
            state="visible", timeout=5000
        )
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_5_msf_dropdown.png"))
        msf_text = (await page.locator(
            "ul.typeahead-list li.typeahead-item"
        ).first.inner_text()).upper()
        ok5 = "MSFT" in msf_text and "MICROSOFT" in msf_text
        log(5, f"type 'msf'; first_item={msf_text!r}")
        check("CP5", ok5, f"first_item={msf_text!r}")
        results["CP5"] = ok5

        # ---- CP9: Escape closes an open dropdown ----
        before = await page.locator("ul.typeahead-list").count()
        await combo.press("Escape")
        await page.wait_for_timeout(400)
        after = await page.locator("ul.typeahead-list").count()
        await page.screenshot(path=str(SCREENSHOTS / "final_execution_9_escape.png"))
        ok9 = before >= 1 and after == 0
        log(9, f"Escape; typeahead-list count before={before} after={after}")
        check("CP9", ok9, f"before={before} after={after}")
        results["CP9"] = ok9

        await b.close()

    all_pass = all(results.values())
    with LOG.open("a") as f:
        f.write(f"\nRESULTS: {results}\n")
        f.write(f"ALL_CRITICAL_POINTS_PASS: {all_pass}\n")
    print(f"\nRESULTS: {results}")
    print(f"ALL_CRITICAL_POINTS_PASS: {all_pass}")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    asyncio.run(main())
