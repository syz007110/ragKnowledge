"""Convert HTML (e.g. Markdown-rendered) into unified schema page blocks."""

from __future__ import annotations

import base64
import re
from typing import Any, Callable

from app.parsers.unified_builders import (
    IdGen,
    code_block_u,
    figure_block_u,
    list_block_u,
    paragraph_block,
    sha256_bytes,
    table_block_nested,
    title_block,
)

try:
    from bs4 import BeautifulSoup, NavigableString
    from bs4.element import Tag as Bs4Tag
except ImportError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore[misc, assignment]
    NavigableString = None  # type: ignore[misc, assignment]

    class _MissingBs4Tag:  # type: ignore[misc, assignment]
        pass

    Bs4Tag = _MissingBs4Tag


def _strip_noise(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _table_to_matrix(table_tag: Any) -> list[list[str]]:
    rows_out: list[list[str]] = []
    for tr in table_tag.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        rows_out.append([_strip_noise(c.get_text()) for c in cells])
    return [r for r in rows_out if any(x for x in r)]


def _list_items(list_tag: Any) -> tuple[list[str], str]:
    style = "ordered" if list_tag.name == "ol" else "bullet"
    items: list[str] = []
    for li in list_tag.find_all("li", recursive=False):
        items.append(_strip_noise(li.get_text()))
    return [i for i in items if i], style


def _paragraph_from_element(id_gen: IdGen, p_tag: Any, reading_order: int) -> dict[str, Any] | None:
    text = _strip_noise(p_tag.get_text())
    if not text:
        return None
    return paragraph_block(id_gen, text, reading_order)


def _handle_data_uri_image(
    img_tag: Any,
    src: str,
    id_gen: IdGen,
    blocks: list[dict[str, Any]],
    legacy_images: list[dict[str, Any]],
    next_ro: Callable[[], int],
) -> None:
    m = re.match(r"data:([^;]+);base64,(.+)", src, re.DOTALL | re.IGNORECASE)
    if not m:
        return
    mime = m.group(1).strip()
    alt = _strip_noise(str(img_tag.get("alt") or ""))
    try:
        raw = base64.b64decode(m.group(2).strip())
    except Exception:
        return
    asset_id = f"ast-img-{id_gen.next()}"
    b64 = base64.b64encode(raw).decode("ascii")
    legacy_images.append({
        "imageKey": asset_id,
        "contentType": mime or "image/png",
        "base64": b64,
        "byteLength": len(raw),
        "sha256": sha256_bytes(raw),
    })
    fb = figure_block_u(id_gen, asset_id, next_ro(), caption=alt or None)
    if fb:
        blocks.append(fb)


def blocks_from_html(
    html: str,
    id_gen: IdGen,
    *,
    legacy_images: list[dict[str, Any]],
    extract_embedded_images: bool = True,
) -> list[dict[str, Any]]:
    if not BeautifulSoup:
        raise RuntimeError("parser.htmlUnavailable")
    soup = BeautifulSoup(html or "", "html.parser")
    body = soup.body if soup.body else soup
    blocks: list[dict[str, Any]] = []
    ro = 0

    def next_ro() -> int:
        nonlocal ro
        cur = ro
        ro += 1
        return cur

    def handle_figure_for_kb_asset(src: str) -> None:
        aid = src.replace("kb-asset://", "").strip()
        if not aid:
            return
        b = figure_block_u(id_gen, aid, next_ro(), caption=None)
        if b:
            blocks.append(b)

    for el in list(body.children):
        if NavigableString and isinstance(el, NavigableString):
            if _strip_noise(str(el)):
                pb = paragraph_block(id_gen, _strip_noise(str(el)), next_ro())
                if pb:
                    blocks.append(pb)
            continue
        if not isinstance(el, Bs4Tag):
            continue
        name = (el.name or "").lower()

        if name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            level = int(name[1])
            text = _strip_noise(el.get_text())
            tb = title_block(id_gen, text, level, next_ro())
            if tb:
                blocks.append(tb)
            continue

        if name == "p":
            for img in list(el.find_all("img")):
                src = str(img.get("src") or "")
                if src.startswith("kb-asset://"):
                    handle_figure_for_kb_asset(src)
                elif extract_embedded_images and src.startswith("data:"):
                    _handle_data_uri_image(img, src, id_gen, blocks, legacy_images, next_ro)
                img.decompose()
            pb = _paragraph_from_element(id_gen, el, next_ro())
            if pb:
                blocks.append(pb)
            continue

        if name in ("ul", "ol"):
            items, style = _list_items(el)
            lb = list_block_u(id_gen, items, next_ro(), list_style=style)
            if lb:
                blocks.append(lb)
            continue

        if name == "table":
            matrix = _table_to_matrix(el)
            tb = table_block_nested(id_gen, matrix, next_ro(), caption=None)
            if tb:
                blocks.append(tb)
            continue

        if name == "pre":
            raw = el.get_text()
            cb = code_block_u(id_gen, raw, next_ro())
            if cb:
                blocks.append(cb)
            continue

        if name == "blockquote":
            text = _strip_noise(el.get_text())
            pb = paragraph_block(id_gen, text, next_ro())
            if pb:
                blocks.append(pb)
            continue

        if name == "img":
            src = str(el.get("src") or "")
            if src.startswith("kb-asset://"):
                handle_figure_for_kb_asset(src)
            elif extract_embedded_images and src.startswith("data:"):
                _handle_data_uri_image(el, src, id_gen, blocks, legacy_images, next_ro)
            continue

        if name in ("div", "section", "article"):
            inner_blocks = blocks_from_html(
                str(el),
                id_gen,
                legacy_images=legacy_images,
                extract_embedded_images=extract_embedded_images,
            )
            for ib in inner_blocks:
                ib["readingOrder"] = next_ro()
                blocks.append(ib)
            continue

    return blocks
