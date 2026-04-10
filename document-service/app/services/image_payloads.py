"""Build embeddedImagePayloads map from IngestParseResult (aligned with parseDocument.assets[].id)."""

from __future__ import annotations

import base64
import binascii
import hashlib
from typing import Any

from app.parsers.types import IngestParseResult


def _image_rows_from_result(result: IngestParseResult) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if result.docx and isinstance(result.docx.get("images"), list):
        for img in result.docx["images"]:
            if isinstance(img, dict):
                rows.append(img)
    if result.embedded_images:
        for img in result.embedded_images:
            if isinstance(img, dict):
                rows.append(img)
    if result.pdf and isinstance(result.pdf.get("assets"), list):
        for a in result.pdf["assets"]:
            if not isinstance(a, dict):
                continue
            key = str(a.get("assetKey") or "").strip()
            b64 = str(a.get("base64") or "").strip()
            if not key or not b64:
                continue
            rows.append({
                "imageKey": key,
                "contentType": a.get("contentType") or "application/octet-stream",
                "base64": b64,
                "byteLength": a.get("byteLength"),
                "sha256": a.get("sha256"),
            })
    return rows


def build_embedded_image_payloads(result: IngestParseResult) -> dict[str, dict[str, Any]]:
    """Keys match parseDocument.assets[].id and figure.assetRef / chunkView imageKey."""
    out: dict[str, dict[str, Any]] = {}
    for row in _image_rows_from_result(result):
        key = str(row.get("imageKey") or "").strip()
        if not key:
            continue
        b64 = str(row.get("base64") or "").strip()
        if not b64:
            continue
        raw: bytes = b""
        try:
            raw = base64.b64decode(b64, validate=False)
        except (binascii.Error, ValueError):
            continue
        if not raw:
            continue
        raw_len = int(row.get("byteLength") or 0) or len(raw)
        sha = str(row.get("sha256") or "").strip()
        if not sha:
            sha = hashlib.sha256(raw).hexdigest()
        out[key] = {
            "id": key,
            "contentType": str(row.get("contentType") or "application/octet-stream"),
            "byteLength": raw_len,
            "sha256": sha,
            "base64": b64,
        }
    return out
