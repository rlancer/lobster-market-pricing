"""Signed Kalshi Trade API helpers. Never log PEM material or key ids in full."""

from __future__ import annotations

import base64
import os
import time
from pathlib import Path
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from lobster_nb.env import load_repo_env, repo_root

DEFAULT_API_BASE = "https://api.elections.kalshi.com/trade-api/v2"


def _pem_text() -> str | None:
    load_repo_env()
    inline = (os.environ.get("KALSHI_PRIVATE_KEY_PEM") or "").strip()
    if inline:
        return inline.replace("\\n", "\n")
    rel = (os.environ.get("KALSHI_PRIVATE_KEY_FILE") or "").strip()
    if not rel:
        return None
    candidate = Path(rel)
    search = [candidate] if candidate.is_absolute() else [
        repo_root() / rel,
        repo_root() / "loader" / rel,
        repo_root() / "loader" / Path(rel).name,
    ]
    for path in search:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    return None


def auth_configured() -> bool:
    load_repo_env()
    key_id = (os.environ.get("KALSHI_ACCESS_KEY_ID") or "").strip()
    return bool(key_id and _pem_text())


def sign_path(url: str) -> str:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.path:
        return parsed.path
    no_query = url.split("?", 1)[0]
    idx = no_query.find("/trade-api/")
    return no_query[idx:] if idx >= 0 else no_query


def auth_headers(method: str, url: str, now_ms: int | None = None) -> dict[str, str] | None:
    """RSA-PSS headers matching loader/src/kalshi.ts buildKalshiAuthHeaders."""
    load_repo_env()
    key_id = (os.environ.get("KALSHI_ACCESS_KEY_ID") or "").strip()
    pem = _pem_text()
    if not key_id or not pem:
        return None
    timestamp = str(now_ms if now_ms is not None else int(time.time() * 1000))
    message = f"{timestamp}{method.upper()}{sign_path(url)}"
    key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
    signature = key.sign(
        message.encode("utf-8"),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32),
        hashes.SHA256(),
    )
    return {
        "KALSHI-ACCESS-KEY": key_id,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(signature).decode("ascii"),
    }


def ping(timeout_s: float = 20.0) -> dict[str, Any]:
    """Signed GET /exchange/status — status code only, no body dump."""
    load_repo_env()
    base = (os.environ.get("KALSHI_API_BASE") or DEFAULT_API_BASE).rstrip("/")
    url = f"{base}/exchange/status"
    headers = auth_headers("GET", url) or {}
    try:
        response = httpx.get(url, headers=headers, timeout=timeout_s)
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:300], "signed": bool(headers)}
    return {
        "ok": response.is_success,
        "status": response.status_code,
        "signed": bool(headers),
    }
