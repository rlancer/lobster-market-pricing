"""Verify the new default '50 strikes around spot' filter in the screener."""
import os, sys
sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright

URL = os.environ.get("SCREENER_URL", "http://localhost:5173")
RUN = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(RUN, "screenshots"); os.makedirs(SHOTS, exist_ok=True)
LOG = open(os.path.join(RUN, "final_script_log.txt"), "w", encoding="utf-8")
step = 0
def log(a):
    global step; step += 1
    line = f"step {step} action: {a}"; print(line); LOG.write(line+"\n"); LOG.flush()

with sync_playwright() as p:
    b = p.firefox.launch(headless=True)
    pg = b.new_page(viewport={"width": 1280, "height": 1800})
    pg.goto(URL, wait_until="networkidle"); pg.wait_for_timeout(800)
    log("load screener")

    # The new filter control exists with default value 50.
    near = pg.locator("input[placeholder='50']").first
    val = near.input_value()
    log(f"CP1 'Strikes around spot' control present, default={val!r}")
    assert val == "50", f"CP1 FAIL: default={val!r}"
    pg.screenshot(path=os.path.join(SHOTS, "01_default50.png"))

    # Select AAPL via typeahead, wait for table.
    combo = pg.get_by_role("combobox").first
    combo.click(); combo.fill("AAPL"); pg.wait_for_timeout(700)
    pg.wait_for_selector("ul.typeahead-list li.typeahead-item", timeout=4000)
    combo.press("ArrowDown"); combo.press("Enter"); pg.wait_for_timeout(1200)
    # read the API response for the screen call to confirm near_spot_strikes=50 sent
    # (rely on table: distinct strikes should be <= 50 and wrap spot)
    rows = pg.locator("table.screener tbody tr")
    syms = []
    for i in range(rows.count()):
        t = rows.nth(i).inner_text()
        if t.strip() and "No contracts" not in t:
            syms.append(t.split()[0])
    log(f"CP2 selected AAPL; table rows={len(syms)}, all AAPL={all(s=='AAPL' for s in syms)}")
    assert syms and all(s == "AAPL" for s in syms)
    pg.screenshot(path=os.path.join(SHOTS, "02_aapl_default.png"))

    # Fetch the same query via API to assert the band wraps spot with <=50 strikes.
    import urllib.request, json as J
    raw = urllib.request.urlopen("http://127.0.0.1:8001/api/screen?symbol=AAPL&near_spot_strikes=50&sort=strike&order=asc&limit=5000").read()
    d = J.loads(raw); items = d["items"]
    spot = items[0]["spot"]; strikes = sorted({r["strike"] for r in items})
    below = sum(1 for s in strikes if s < spot)
    above = sum(1 for s in strikes if s > spot)
    log(f"CP3 API: distinct strikes={len(strikes)} (<=50), below spot={below} above={above}, spot={spot:.2f}")
    assert len(strikes) <= 50
    assert below >= 1 and above >= 1, "band must wrap spot"
    log(f"CP3 PASS: band wraps spot (below={below}, above={above})")
    pg.screenshot(path=os.path.join(SHOTS, "03_band_wraps.png"))

    # Change control to 0 -> disabled; the visible row count stays capped at
    # the Rows selector (100), so read the 'Showing X of Y' total instead.
    meta_before = pg.locator(".table-meta").inner_text()
    near.fill(""); near.fill("0"); near.press("Tab"); pg.wait_for_timeout(1200)
    meta_after = pg.locator(".table-meta").inner_text()
    import re
    tb = int(re.search(r"of ([\d,]+)", meta_before).group(1).replace(",", ""))
    ta = int(re.search(r"of ([\d,]+)", meta_after).group(1).replace(",", ""))
    log(f"CP4 band ON total={tb}, band OFF total={ta}")
    assert ta > tb, f"CP4 FAIL: disabling band did not raise total ({ta} vs {tb})"
    pg.screenshot(path=os.path.join(SHOTS, "04_disabled.png"))

    b.close()
final = "VERIFIED: default 50 strikes around spot wraps spot (<=50, both sides), 0 disables."
print("\n"+final); LOG.write("\n"+final+"\n"); LOG.close()
