"""Verify the Symbol typeahead in the S&P 500 Options Screener.

Drives a local Firefox via Playwright against the Vite dev server and
confirms the typeahead searches by company name, supports keyboard
navigation + selection, and filters the screener table.

All artifacts (screenshots + log) are written next to this script.
"""
import os
import sys
import time

# Force UTF-8 stdout so the Γ/Δ/Θ/ν greek letters in the UI don't crash
# Windows cp1252 console encoding when we print page text.
sys.stdout.reconfigure(encoding="utf-8")

from playwright.sync_api import sync_playwright

URL = os.environ.get("SCREENER_URL", "http://localhost:5173")
RUN_DIR = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(RUN_DIR, "screenshots")
os.makedirs(SHOTS, exist_ok=True)
LOG_PATH = os.path.join(RUN_DIR, "final_script_log.txt")

_log = open(LOG_PATH, "w", encoding="utf-8")
_step = 0


def log(action: str) -> None:
    global _step
    _step += 1
    line = f"step {_step} action: {action}"
    print(line)
    _log.write(line + "\n")
    _log.flush()


def shot(page, name: str) -> str:
    path = os.path.join(SHOTS, f"final_execution_{name}.png")
    page.screenshot(path=path)
    return path


def main() -> None:
    chosen_ticker = "AAPL"
    with sync_playwright() as p:
        b = p.firefox.launch(headless=True)
        pg = b.new_page(viewport={"width": 1280, "height": 1800})

        # Capture API calls to prove the typeahead hits the backend.
        api_calls: list[tuple[str, str]] = []
        pg.on("request",
              lambda req: api_calls.append((req.method, req.url))
              if "/api/symbols" in req.url else None)

        pg.goto(URL, wait_until="networkidle")
        pg.wait_for_timeout(700)
        log("load screener page")

        # CP1: the Symbol control is a combobox with the typeahead placeholder.
        combo = pg.get_by_role("combobox").first
        ph = combo.get_attribute("placeholder")
        assert ph and "ticker" in ph.lower() and "name" in ph.lower(), \
            f"CP1 FAIL: unexpected placeholder {ph!r}"
        log(f"CP1 Symbol control is combobox, placeholder={ph!r}")
        shot(pg, "01_loaded")

        # CP2: type a company NAME ("apple") and confirm the dropdown
        # surfaces AAPL / Apple Inc. sourced from the backend.
        combo.click()
        combo.fill("apple")
        pg.wait_for_timeout(700)  # debounce 150ms + network + render
        log('CP2 type company name "apple" into typeahead')

        # Wait for the dropdown listbox with at least one option.
        pg.wait_for_selector("ul.typeahead-list li.typeahead-item",
                             timeout=4000)
        items = pg.locator("ul.typeahead-list li.typeahead-item")
        first_text = items.nth(0).inner_text()
        log(f"CP2 dropdown first item: {first_text!r}")
        ft = first_text.upper()
        assert "AAPL" in ft and "APPLE" in ft, \
            f"CP2 FAIL: first item not AAPL/Apple: {first_text!r}"
        assert any("/api/symbols?q=" in u and "apple" in u.lower() for _, u in api_calls), \
            f"CP2 FAIL: no /api/symbols?q=apple request; calls={api_calls}"
        shot(pg, "02_dropdown_apple")

        # CP5: ticker-prefix search "MSF" should surface MSFT at top.
        combo.fill("MSF")
        pg.wait_for_timeout(700)
        pg.wait_for_selector("ul.typeahead-list li.typeahead-item", timeout=4000)
        ms_items = pg.locator("ul.typeahead-list li.typeahead-item")
        ms_first = ms_items.nth(0).inner_text()
        log(f"CP5 typed 'MSF', first item: {ms_first!r}")
        assert "MSFT" in ms_first.upper(), f"CP5 FAIL: MSF did not surface MSFT: {ms_first!r}"
        shot(pg, "05_msf_prefix")

        # CP3: keyboard navigation — Down to highlight, Enter to select.
        combo.click()
        combo.fill("apple")
        pg.wait_for_timeout(700)
        pg.wait_for_selector("ul.typeahead-list li.typeahead-item", timeout=4000)

        # Press Down to move active highlight onto the first item.
        combo.press("ArrowDown")
        pg.wait_for_timeout(150)
        active = pg.locator("ul.typeahead-list li.typeahead-item.active")
        assert active.count() >= 1, "CP3 FAIL: no .active item after ArrowDown"
        active_text = active.first.inner_text()
        log(f"CP3 ArrowDown highlighted active item: {active_text!r}")
        shot(pg, "03_arrowdown_active")

        # Enter selects the active item -> Symbol field becomes the ticker.
        combo.press("Enter")
        pg.wait_for_timeout(900)  # let debounced screen re-run
        val = combo.input_value()
        log(f"CP3 Enter pressed; Symbol field value={val!r}")
        assert val == chosen_ticker, \
            f"CP3 FAIL: after Enter, Symbol value={val!r}, expected {chosen_ticker!r}"

        # CP4: screener table rows now all equal the chosen ticker.
        # Wait for the table body rows.
        pg.wait_for_selector("table.screener tbody tr", timeout=6000)
        pg.wait_for_timeout(400)
        rows = pg.locator("table.screener tbody tr")
        nrow = rows.count()
        log(f"CP4 table has {nrow} data rows after selecting {val!r}")
        # Only inspect non-empty rows (skip the "no contracts" colSpan row).
        syms: list[str] = []
        for i in range(nrow):
            t = rows.nth(i).inner_text()
            first_cell = t.split()[0] if t.strip() else ""
            if first_cell and "No contracts" not in t:
                syms.append(first_cell)
        log(f"CP4 row symbols: {syms[:8]}{'...' if len(syms)>8 else ''}")
        assert syms, "CP4 FAIL: no data rows present after selection"
        assert all(s == chosen_ticker for s in syms), \
            f"CP4 FAIL: not all rows = {chosen_ticker!r}: {syms[:8]}"
        shot(pg, "04_table_filtered")

        # Esc should close any open dropdown (sanity).
        combo.click()
        combo.fill("amzn")
        pg.wait_for_timeout(700)
        pg.wait_for_selector("ul.typeahead-list li.typeahead-item", timeout=4000)
        combo.press("Escape")
        pg.wait_for_timeout(300)
        closed = pg.locator("ul.typeahead-list").count() == 0
        log(f"Escape closes dropdown: {closed}")
        shot(pg, "06_after_escape")

        b.close()

    final = f"VERIFIED: Symbol typeahead searches by name (apple->AAPL), " \
           f"keyboard Down+Enter selects, table filters to {chosen_ticker}."
    print("\n" + final)
    _log.write("\n" + final + "\n")
    _log.flush()
    _log.close()


if __name__ == "__main__":
    main()
