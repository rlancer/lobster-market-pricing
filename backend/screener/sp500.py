"""Fetch the current S&P 500 constituent list from Wikipedia."""
from __future__ import annotations

import io

import pandas as pd
import requests

WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}


def fetch_sp500() -> pd.DataFrame:
    """Return a DataFrame with columns: symbol, name, sector."""
    html = requests.get(WIKI_URL, headers=HEADERS, timeout=30).text
    tables = pd.read_html(io.StringIO(html))
    df = tables[0][["Symbol", "Security", "GICS Sector"]].copy()
    df.columns = ["symbol", "name", "sector"]
    # Wikipedia uses dots in some symbols (BRK.B); Yahoo expects dashes (BRK-B).
    df["symbol"] = df["symbol"].str.strip().str.replace(".", "-", regex=False)
    return df
