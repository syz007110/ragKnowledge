"""Helpers to build schemaVersion 2.0 ParseDocument (native route) and projections."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Callable


def _plain_text_from_spans(spans: list[dict]) -> str:
    return "".join(str(s.get("text") or "") for s in spans if isinstance(s, dict))


def _plain_text_from_lines(lines: list[dict] | None) -> str:
    if not lines:
        return ""
    parts: list[str] = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        parts.append(_plain_text_from_spans(line.get("spans") or []))
    return "\n".join(p for p in parts if p)


def raw_text_from_pages(pages: list[dict]) -> str:
    """Flatten all translatable text in reading order (depth-first)."""
    chunks: list[str] = []

    def walk_block(block: dict) -> None:
        if not isinstance(block, dict):
            return
        btype = str(block.get("type") or "")
        lines = block.get("lines")
        if isinstance(lines, list) and lines:
            t = _plain_text_from_lines(lines).strip()
            if t:
                chunks.append(t)
        rows = block.get("rows")
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                for cell in row.get("cells") or []:
                    if not isinstance(cell, dict):
                        continue
                    ct = _plain_text_from_spans(cell.get("spans") or []).strip()
                    if ct:
                        chunks.append(ct)
        for child in block.get("blocks") or []:
            if isinstance(child, dict):
                walk_block(child)
        if btype == "figure" and block.get("assetRef"):
            pass

    for page in pages or []:
        if not isinstance(page, dict):
            continue
        for block in page.get("blocks") or []:
            walk_block(block)
    return "\n\n".join(chunks)


def build_chunk_view(pages: list[dict]) -> dict[str, Any]:
    """Derive chunkView.blocks from pages (heading/paragraph/image/table_*)."""
    blocks: list[dict[str, Any]] = []
    heading_stack: list[str] = []

    def flush_heading_path_for_table() -> str:
        return " > ".join(heading_stack) if heading_stack else ""

    def walk(block: dict, inherited_table_caption: str | None) -> None:
        if not isinstance(block, dict):
            return
        btype = str(block.get("type") or "")
        reading = block.get("readingOrder")

        if btype == "title":
            level = max(1, min(6, int(block.get("level") or 1)))
            text = _plain_text_from_lines(block.get("lines")).strip()
            while len(heading_stack) >= level:
                heading_stack.pop()
            if text:
                item: dict[str, Any] = {"type": "heading", "level": level, "text": text}
                sr = str(block.get("sourceRegion") or "").strip()
                if sr:
                    item["sourceRegion"] = sr
                heading_stack.append(text)
                blocks.append(item)
            return

        if btype == "paragraph":
            text = _plain_text_from_lines(block.get("lines")).strip()
            if text:
                item = {"type": "paragraph", "text": text}
                sr = str(block.get("sourceRegion") or "").strip()
                if sr:
                    item["sourceRegion"] = sr
                blocks.append(item)
            return

        if btype == "formula":
            text = _plain_text_from_lines(block.get("lines")).strip()
            if not text:
                text = str(block.get("formulaLatex") or "").strip()
            if text:
                blocks.append({"type": "paragraph", "text": text})
            return

        if btype == "code":
            text = _plain_text_from_lines(block.get("lines")).strip()
            if text:
                blocks.append({"type": "paragraph", "text": text})
            return

        if btype == "list":
            for child in block.get("blocks") or []:
                walk(child, inherited_table_caption)
            return

        if btype == "list_item":
            text = _plain_text_from_lines(block.get("lines")).strip()
            if text:
                blocks.append({"type": "paragraph", "text": text})
            for child in block.get("blocks") or []:
                walk(child, inherited_table_caption)
            return

        if btype == "figure":
            ref = str(block.get("assetRef") or "").strip()
            if ref:
                img_item: dict[str, Any] = {"type": "image", "imageKey": ref}
                sr = str(block.get("sourceRegion") or "").strip()
                if sr:
                    img_item["sourceRegion"] = sr
                blocks.append(img_item)
            for child in block.get("blocks") or []:
                walk(child, inherited_table_caption)
            return

        if btype == "table":
            caption = inherited_table_caption
            inner_blocks = block.get("blocks") or []
            body: dict | None = None
            cap_text = ""
            for ib in inner_blocks:
                if not isinstance(ib, dict):
                    continue
                it = str(ib.get("type") or "")
                if it == "paragraph":
                    t = _plain_text_from_lines(ib.get("lines")).strip()
                    if t:
                        cap_text = t
                        blocks.append({"type": "paragraph", "text": t})
                elif it == "table" and ib.get("rows"):
                    body = ib
            table_id = str(block.get("id") or "table")
            sheet = flush_heading_path_for_table()
            if body and isinstance(body.get("rows"), list):
                rows = body["rows"]
                if rows:
                    header_cells = (rows[0].get("cells") if isinstance(rows[0], dict) else None) or []
                    headers = [_plain_text_from_spans(c.get("spans") or []).strip() for c in header_cells if isinstance(c, dict)]
                    header_line = " | ".join(h for h in headers if h)
                    summary_text = f"表头: {header_line}" if header_line else (cap_text or "表")
                    blocks.append({
                        "type": "table_summary",
                        "text": summary_text,
                        "sheetName": sheet,
                        "tableId": table_id,
                        "rowIndex": 0,
                    })
                    for idx, row in enumerate(rows[1:], start=1):
                        if not isinstance(row, dict):
                            continue
                        cells = row.get("cells") or []
                        values = [_plain_text_from_spans(c.get("spans") or []).strip() for c in cells if isinstance(c, dict)]
                        row_kv = _row_to_kv_line(headers, values)
                        if not row_kv:
                            continue
                        blocks.append({
                            "type": "table_row",
                            "text": row_kv,
                            "rowKvText": row_kv,
                            "sheetName": sheet,
                            "tableId": table_id,
                            "rowIndex": idx,
                        })
            return

        for child in block.get("blocks") or []:
            walk(child, inherited_table_caption)

    for page in pages or []:
        if not isinstance(page, dict):
            continue
        for block in page.get("blocks") or []:
            walk(block, None)

    return {"blocks": blocks}


def pages_have_bbox(pages: list[dict]) -> bool:
    def walk_block(block: dict) -> bool:
        if not isinstance(block, dict):
            return False
        if block.get("bbox"):
            return True
        for line in block.get("lines") or []:
            if not isinstance(line, dict):
                continue
            if line.get("bbox"):
                return True
            for sp in line.get("spans") or []:
                if isinstance(sp, dict) and sp.get("bbox"):
                    return True
        for ch in block.get("blocks") or []:
            if isinstance(ch, dict) and walk_block(ch):
                return True
        return False

    for page in pages or []:
        if not isinstance(page, dict):
            continue
        for block in page.get("blocks") or []:
            if isinstance(block, dict) and walk_block(block):
                return True
    return False


def _row_to_kv_line(headers: list[str], values: list[str]) -> str:
    pieces: list[str] = []
    max_len = max(len(headers), len(values))
    for idx in range(max_len):
        header = (headers[idx] if idx < len(headers) else "") or f"列{idx + 1}"
        value = values[idx] if idx < len(values) else ""
        value = str(value or "").strip()
        if not value:
            continue
        pieces.append(f"{header}: {value}")
    return "; ".join(pieces)


DOCX_READING_ORDER_POLICY = (
    "per_section: unique header parts then unique footer parts (dedup by part name), "
    "then document body (with textbox content after each paragraph), "
    "then footnotes part, then endnotes part"
)


def assemble_parse_document(
    *,
    file_ext: str,
    parser_kind: str,
    source_file_name: str,
    pages: list[dict],
    assets: list[dict],
    warnings: list[str] | None = None,
    reading_order_policy: str | None = None,
    parse_route: str = "native",
    has_bbox: bool | None = None,
    meta_extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    warn = list(warnings or [])
    use_pages = pages if pages else [{"pageIndex": 0, "blocks": []}]
    hb = has_bbox if has_bbox is not None else pages_have_bbox(use_pages)
    meta: dict[str, Any] = {
        "pageCount": len(use_pages) if use_pages else 1,
        "sourceFileName": source_file_name or "",
        "warnings": warn,
        "hasBbox": hb,
    }
    if reading_order_policy:
        meta["readingOrderPolicy"] = reading_order_policy
    if meta_extra:
        for k, v in meta_extra.items():
            meta[k] = v
    doc: dict[str, Any] = {
        "schemaVersion": "2.0",
        "parseRoute": parse_route,
        "fileExt": file_ext,
        "parserKind": parser_kind,
        "meta": meta,
        "assets": assets,
        "pages": use_pages,
    }
    doc["chunkView"] = build_chunk_view(doc["pages"])
    return doc


class IdGen:
    __slots__ = ("_prefix", "_n")

    def __init__(self, prefix: str = "id") -> None:
        self._prefix = prefix
        self._n = 0

    def next(self) -> str:
        self._n += 1
        return f"{self._prefix}-{self._n}"


def span_text(id_gen: IdGen, text: str, *, styles: list[str] | None = None, translatable: bool = True) -> dict[str, Any]:
    s: dict[str, Any] = {
        "id": f"sp-{id_gen.next()}",
        "text": text,
        "translatable": translatable,
    }
    if styles:
        s["style"] = styles
    return s


def line_from_spans(id_gen: IdGen, spans: list[dict]) -> dict[str, Any]:
    return {"id": f"ln-{id_gen.next()}", "spans": spans}


def paragraph_block(
    id_gen: IdGen,
    text: str,
    reading_order: int,
    *,
    source_region: str | None = None,
) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    sp = span_text(id_gen, text)
    out: dict[str, Any] = {
        "id": f"blk-{id_gen.next()}",
        "type": "paragraph",
        "readingOrder": reading_order,
        "lines": [line_from_spans(id_gen, [sp])],
    }
    if source_region:
        out["sourceRegion"] = source_region
    return out


def title_block(
    id_gen: IdGen,
    text: str,
    level: int,
    reading_order: int,
    *,
    source_region: str | None = None,
) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    sp = span_text(id_gen, text, styles=["bold"])
    out: dict[str, Any] = {
        "id": f"blk-{id_gen.next()}",
        "type": "title",
        "readingOrder": reading_order,
        "level": max(1, min(6, level)),
        "lines": [line_from_spans(id_gen, [sp])],
    }
    if source_region:
        out["sourceRegion"] = source_region
    return out


def code_block_u(id_gen: IdGen, text: str, reading_order: int) -> dict[str, Any]:
    raw = text or ""
    if not raw.strip():
        return {}
    sp = span_text(id_gen, raw, translatable=False)
    return {
        "id": f"blk-{id_gen.next()}",
        "type": "code",
        "readingOrder": reading_order,
        "lines": [line_from_spans(id_gen, [sp])],
    }


def table_block_nested(
    id_gen: IdGen,
    rows_matrix: list[list[str]],
    reading_order: int,
    *,
    caption: str | None = None,
    source_region: str | None = None,
) -> dict[str, Any]:
    if not rows_matrix:
        return {}
    row_objs: list[dict[str, Any]] = []
    for ri, row in enumerate(rows_matrix):
        cells: list[dict[str, Any]] = []
        for ci, cell_text in enumerate(row):
            ct = str(cell_text or "").strip()
            sp = span_text(id_gen, ct)
            cells.append({"id": f"c-{ri}-{ci}", "spans": [sp]})
        row_objs.append({"id": f"row-{ri}", "cells": cells})
    outer_id = f"blk-{id_gen.next()}"
    inner_table_id = f"blk-{id_gen.next()}"
    inner: dict[str, Any] = {
        "id": inner_table_id,
        "type": "table",
        "readingOrder": 1,
        "rows": row_objs,
    }
    children: list[dict[str, Any]] = []
    if caption and caption.strip():
        cap = paragraph_block(id_gen, caption.strip(), 0)
        cap["id"] = f"blk-{id_gen.next()}"
        cap["readingOrder"] = 0
        children.append(cap)
    children.append(inner)
    out: dict[str, Any] = {
        "id": outer_id,
        "type": "table",
        "readingOrder": reading_order,
        "blocks": children,
    }
    if source_region:
        out["sourceRegion"] = source_region
    return out


def figure_block_u(
    id_gen: IdGen,
    asset_id: str,
    reading_order: int,
    *,
    caption: str | None = None,
    source_region: str | None = None,
) -> dict[str, Any]:
    fb: dict[str, Any] = {
        "id": f"blk-{id_gen.next()}",
        "type": "figure",
        "readingOrder": reading_order,
        "assetRef": asset_id,
        "blocks": [],
    }
    if source_region:
        fb["sourceRegion"] = source_region
    if caption and caption.strip():
        cb = paragraph_block(id_gen, caption.strip(), 0)
        cb["id"] = f"blk-{id_gen.next()}"
        fb["blocks"] = [cb]
    return fb


def list_block_u(
    id_gen: IdGen,
    items: list[str],
    reading_order: int,
    *,
    list_style: str = "bullet",
) -> dict[str, Any]:
    lb_id = f"blk-{id_gen.next()}"
    children: list[dict[str, Any]] = []
    for i, item in enumerate(items):
        t = (item or "").strip()
        if not t:
            continue
        sp = span_text(id_gen, t)
        children.append({
            "id": f"blk-{id_gen.next()}",
            "type": "list_item",
            "readingOrder": i,
            "lines": [line_from_spans(id_gen, [sp])],
        })
    if not children:
        return {}
    return {
        "id": lb_id,
        "type": "list",
        "readingOrder": reading_order,
        "listStyle": list_style,
        "blocks": children,
    }


def legacy_docx_payload(
    parse_document: dict[str, Any],
    *,
    images: list[dict[str, Any]],
) -> dict[str, Any]:
    """Shape expected by Node kbIngestProcessor: blocks + images (base64)."""
    cv = parse_document.get("chunkView") or {}
    blocks = list(cv.get("blocks") or [])
    return {"blocks": blocks, "images": images}


def legacy_xlsx_payload(parse_document: dict[str, Any]) -> dict[str, Any]:
    cv = parse_document.get("chunkView") or {}
    return {"blocks": list(cv.get("blocks") or [])}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def decode_text_bytes(file_bytes: bytes) -> tuple[str, list[str]]:
    """Decode as UTF-8 (with BOM) or fall back to charset-normalizer."""
    warnings: list[str] = []
    if not file_bytes:
        return "", warnings
    if file_bytes.startswith(b"\xef\xbb\xbf"):
        return file_bytes[3:].decode("utf-8", errors="replace"), warnings
    try:
        return file_bytes.decode("utf-8"), warnings
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes

        best = from_bytes(file_bytes).best()
        if best:
            text = str(best)
            enc = best.encoding or "unknown"
            if enc.lower() not in ("utf_8", "utf-8"):
                warnings.append(f"decoded_as:{enc}")
            return text, warnings
    except Exception:
        pass
    warnings.append("decoded_as_utf8_replace")
    return file_bytes.decode("utf-8", errors="replace"), warnings
