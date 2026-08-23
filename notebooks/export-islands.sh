#!/usr/bin/env bash
# Regenerate the CDN-backed marimo islands HTML from notebooks/*.py.
# Requires: pip install marimo  (or mise + uv)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/frontend/public/notebooks/lake-sectors"
mkdir -p "$OUT"
python3 - <<PY
from marimo import MarimoIslandGenerator

gen = MarimoIslandGenerator.from_file(
    "$ROOT/notebooks/lake_sectors.py",
    display_code=True,
)
# include_init_island=False: the standalone "Initializing…" island can stick
# around after a cell error and looks like a permanent hang.
html = gen.render_html(include_init_island=False)
path = "$OUT/index.html"
with open(path, "w", encoding="utf-8") as f:
    f.write(html)
print(f"wrote {path} ({len(html.encode())} bytes)")
PY
