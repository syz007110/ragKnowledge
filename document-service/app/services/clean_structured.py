"""Structured cleanup: drop header/footer (and optional regions), filter assets, annotate chunkView.headingPath."""

from __future__ import annotations

from typing import Any

from app.parsers.unified_builders import build_chunk_view

# Regions removed from body stream for default policy (see docs/cleaned-parse-schema.example.json).
# `toc`: paragraphs tagged in DOCX parse via Word built-in TOC / figure-catalog styles (see docx_parser).
DEFAULT_DROP_SOURCE_REGIONS: frozenset[str] = frozenset({"header", "footer", "toc"})


def _region_to_drop(sr: str, drop_regions: frozenset[str]) -> bool:
    s = str(sr or "").strip()
    return bool(s and s in drop_regions)


def _filter_blocks(blocks: list[Any], drop_regions: frozenset[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        if _region_to_drop(str(block.get("sourceRegion") or ""), drop_regions):
            continue
        nb: dict[str, Any] = dict(block)
        if isinstance(nb.get("blocks"), list):
            nb["blocks"] = _filter_blocks(nb["blocks"], drop_regions)
        out.append(nb)
    return out


def _filter_pages(pages: list[Any], drop_regions: frozenset[str]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for page in pages or []:
        if not isinstance(page, dict):
            continue
        np = dict(page)
        np["blocks"] = _filter_blocks(page.get("blocks") or [], drop_regions)
        cleaned.append(np)
    return cleaned


def _walk_collect_asset_refs(blocks: list[Any], into: set[str]) -> None:
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        ref = str(block.get("assetRef") or "").strip()
        if ref:
            into.add(ref)
        _walk_collect_asset_refs(block.get("blocks") or [], into)
        for row in block.get("rows") or []:
            if not isinstance(row, dict):
                continue
            for cell in row.get("cells") or []:
                if not isinstance(cell, dict):
                    continue
                for sp in cell.get("spans") or []:
                    if isinstance(sp, dict) and sp.get("assetRef"):
                        into.add(str(sp["assetRef"]).strip())


def _collect_asset_refs_from_pages(pages: list[Any]) -> set[str]:
    refs: set[str] = set()
    for page in pages or []:
        if not isinstance(page, dict):
            continue
        _walk_collect_asset_refs(page.get("blocks") or [], refs)
    return refs


def _collect_image_keys_from_chunk_blocks(blocks: list[Any]) -> set[str]:
    keys: set[str] = set()
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        if str(b.get("type") or "") == "image":
            k = str(b.get("imageKey") or "").strip()
            if k:
                keys.add(k)
    return keys


def annotate_chunk_view_heading_paths(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Match structured_chunking heading stack semantics; mutates copies only."""
    stack: list[str] = []
    out: list[dict[str, Any]] = []
    for raw in blocks:
        if not isinstance(raw, dict):
            continue
        b = dict(raw)
        bt = str(b.get("type") or "")
        if bt == "heading":
            level = max(1, min(6, int(b.get("level") or 1)))
            text = str(b.get("text") or "").strip()
            while len(stack) >= level:
                stack.pop()
            if text:
                stack.append(text)
            b["headingPath"] = list(stack)
        else:
            b["headingPath"] = list(stack)
        out.append(b)
    return out


def clean_parse_document(
    parse_document: dict[str, Any],
    *,
    drop_source_regions: frozenset[str] | None = None,
    policy: str = "docx_body_v1",
) -> dict[str, Any]:
    """
    Build CleanedDocument (schemaVersion 1.0) from ParseDocument 2.x.

    - Removes blocks whose sourceRegion is in drop_source_regions (default header/footer).
    - Rebuilds chunkView from filtered pages; adds headingPath to each flat block.
    - Filters assets to those still referenced from kept page tree or chunkView image keys.
    """
    drop = drop_source_regions if drop_source_regions is not None else DEFAULT_DROP_SOURCE_REGIONS
    pd = parse_document or {}
    orig_assets = pd.get("assets") if isinstance(pd.get("assets"), list) else []
    orig_pages = pd.get("pages") if isinstance(pd.get("pages"), list) else []

    all_orig_ids = {str(a.get("id") or "").strip() for a in orig_assets if isinstance(a, dict) and str(a.get("id") or "").strip()}

    filtered_pages = _filter_pages(orig_pages, drop)
    chunk_view_raw = build_chunk_view(filtered_pages)
    blocks_raw = chunk_view_raw.get("blocks") if isinstance(chunk_view_raw, dict) else []
    blocks_safe = [b for b in (blocks_raw or []) if isinstance(b, dict)]
    chunk_blocks = annotate_chunk_view_heading_paths(blocks_safe)

    kept_refs = _collect_asset_refs_from_pages(filtered_pages)
    kept_refs |= _collect_image_keys_from_chunk_blocks(chunk_blocks)

    kept_assets = [a for a in orig_assets if isinstance(a, dict) and str(a.get("id") or "").strip() in kept_refs]
    removed_ids = sorted(all_orig_ids - kept_refs)

    upstream: dict[str, Any] = {
        "parseSchemaVersion": str(pd.get("schemaVersion") or "2.0"),
        "parseRoute": str(pd.get("parseRoute") or "native"),
        "fileExt": str(pd.get("fileExt") or ""),
        "parserKind": str(pd.get("parserKind") or ""),
    }
    if pd.get("meta") and isinstance(pd["meta"], dict) and pd["meta"].get("sourceFileName"):
        upstream["sourceFileName"] = str(pd["meta"]["sourceFileName"])

    meta_in = pd.get("meta") if isinstance(pd.get("meta"), dict) else {}
    meta: dict[str, Any] = {k: v for k, v in meta_in.items() if k != "cleaning"}
    meta["cleaning"] = {
        "policy": policy,
        "droppedSourceRegions": sorted(drop),
        "droppedBlockRoles": [],
        "removedAssetIds": removed_ids,
    }

    return {
        "schemaVersion": "1.0",
        "upstream": upstream,
        "meta": meta,
        "assets": kept_assets,
        "pages": filtered_pages,
        "chunkView": {"blocks": chunk_blocks},
    }
