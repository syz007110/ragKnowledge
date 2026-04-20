"""Use PaddleX PP-StructureV3 *native* page JSON (same shape as ``save_to_json``) as the source of truth.

Each page result's ``.json`` property yields ``{\"res\": { ... }}``; the inner payload contains
``parsing_res_list``, ``table_res_list``, etc. We unwrap and merge table recognition outputs into
layout blocks before mapping to :mod:`app.parsers.unified_builders` / ``parseDocument`` pages.
"""

from __future__ import annotations

import re
from html import unescape
from typing import Any

from app.parsers.unified_builders import IdGen


def unwrap_ppstructure_native_page(result: Any) -> dict[str, Any] | None:
    """Return the inner page dict (``res.json[''res'']``) or *None*."""
    if result is None:
        return None
    raw: Any = None
    j = getattr(result, "json", None)
    if callable(j):
        try:
            raw = j()
        except Exception:
            raw = None
    elif isinstance(j, dict):
        raw = j
    if not isinstance(raw, dict):
        return None
    inner = raw.get("res")
    if isinstance(inner, dict):
        return inner
    return raw


def _rows_from_table_html(html: str, id_gen: IdGen) -> list[dict[str, Any]] | None:
    """Build ``rows`` structure expected by ``_blocks_from_parsing_list`` from ``pred_html``."""
    if not html or "<table" not in html.lower():
        return None
    rows_text: list[list[str]] = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.I | re.S):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, flags=re.I | re.S)
        if not cells:
            continue
        row_vals: list[str] = []
        for c in cells:
            t = re.sub(r"<[^>]+>", " ", c)
            t = unescape(t)
            t = re.sub(r"\s+", " ", t).strip()
            row_vals.append(t)
        rows_text.append(row_vals)
    if not rows_text:
        return None
    row_objs: list[dict[str, Any]] = []
    for ri, row in enumerate(rows_text):
        cells_out: list[dict[str, Any]] = []
        for ci, ct in enumerate(row):
            sp = {
                "id": f"sp-{id_gen.next()}",
                "text": ct,
                "translatable": True,
            }
            cells_out.append({"id": f"c-{ri}-{ci}", "spans": [sp]})
        row_objs.append({"id": f"row-{ri}", "cells": cells_out})
    return row_objs


def _unwrap_table_res_entry(entry: Any) -> dict[str, Any] | None:
    if isinstance(entry, dict):
        if "res" in entry and len(entry) == 1:
            inner = entry.get("res")
            return inner if isinstance(inner, dict) else None
        return entry
    return None


def enrich_native_payload_with_table_res(payload: dict[str, Any], id_gen: IdGen) -> None:
    """Attach ``table_html`` / ``rows`` from ``table_res_list`` to table rows in ``parsing_res_list`` (in place)."""
    parsing = payload.get("parsing_res_list")
    if not isinstance(parsing, list):
        return
    tables_raw = payload.get("table_res_list") or []
    if not isinstance(tables_raw, list) or not tables_raw:
        return
    t_idx = 0
    for item in parsing:
        if not isinstance(item, dict):
            continue
        lab = str(item.get("block_label") or "").lower()
        if "table" not in lab:
            continue
        if t_idx >= len(tables_raw):
            break
        tr = _unwrap_table_res_entry(tables_raw[t_idx])
        t_idx += 1
        if not tr:
            continue
        ph = tr.get("pred_html")
        if isinstance(ph, str) and ph.strip():
            item["table_html"] = ph
            item["html"] = ph
            rows = _rows_from_table_html(ph, id_gen)
            if rows:
                item["rows"] = rows
