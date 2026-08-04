from playwright.sync_api import sync_playwright
import json

URL = "http://localhost:5173"

with sync_playwright() as p:
    b = p.firefox.launch(headless=True)
    pg = b.new_page(viewport={"width": 1280, "height": 1800})
    pg.goto(URL, wait_until="networkidle")
    pg.wait_for_timeout(800)

    # --- CP1: locate the Symbol typeahead input ---
    inputs = pg.get_by_role("combobox")
    n = inputs.count()
    print("combobox count:", n)
    # print placeholder of each input-like element
    all_inputs = pg.locator("input")
    print("total inputs:", all_inputs.count())
    for i in range(all_inputs.count()):
        try:
            ph = all_inputs.nth(i).get_attribute("placeholder")
            print(f"  input[{i}] placeholder={ph!r}")
        except Exception as e:
            print(f"  input[{i}] err {e}")

    # aria snapshot of filters area
    filt = pg.locator(".filters")
    print("--- filters aria ---")
    print(filt.first.inner_text()[:600])
    b.close()
