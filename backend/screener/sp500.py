"""Fetch the current S&P 500 constituent list from Wikipedia.

Returns dotted symbols as-is (BRK.B) because CBOE's delayed-quotes API wants
`BRK.B`, not `BRK-B` (the old Yahoo-dash convention). The CBOE downloader
handles the mapping; this module stays generic.
"""
from __future__ import annotations

import requests
from lxml import html as lh

WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}


def fetch_sp500() -> list[dict]:
    """Return S&P 500 constituents as a list of dicts: symbol, name, sector.

    Symbols keep Wikipedia's dotted form (BRK.B) — no `.` -> `-` conversion.
    """
    resp = requests.get(WIKI_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    tree = lh.fromstring(resp.content)
    # First sortable wikitable on the page is the constituent list.
    table = tree.xpath('//table[contains(@class, "wikitable")][1]')[0]

    rows: list[dict] = []
    for tr in table.xpath(".//tr")[1:]:
        cells = tr.xpath(".//td")
        if len(cells) < 3:
            continue  # skip weird rows / sub-header rows
        symbol = cells[0].text_content().strip()
        name = cells[1].text_content().strip()
        sector = cells[2].text_content().strip()
        if not symbol:
            continue
        rows.append({"symbol": symbol, "name": name, "sector": sector})
    return rows
