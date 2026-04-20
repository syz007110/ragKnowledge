from __future__ import annotations

import base64
import io
import re
import xml.etree.ElementTree as ET
from typing import Any

from app.parsers.types import BaseParser, IngestParseResult
from app.parsers.unified_builders import (
    DOCX_READING_ORDER_POLICY,
    IdGen,
    assemble_parse_document,
    figure_block_u,
    legacy_docx_payload,
    paragraph_block,
    raw_text_from_pages,
    sha256_bytes,
    table_block_nested,
    title_block,
)

try:
    from docx import Document
    from docx.oxml.ns import qn
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.table import Table
    from docx.text.hyperlink import Hyperlink as DocxHyperlink
    from docx.text.paragraph import Paragraph
    from docx.text.run import Run as DocxRun
except Exception:  # pragma: no cover - optional dependency
    Document = None  # type: ignore[misc, assignment]
    qn = None  # type: ignore[misc, assignment]
    CT_Tbl = None  # type: ignore[misc, assignment]
    CT_P = None  # type: ignore[misc, assignment]
    RT = None  # type: ignore[misc, assignment]
    Table = None  # type: ignore[misc, assignment]
    Paragraph = None  # type: ignore[misc, assignment]
    DocxHyperlink = None  # type: ignore[misc, assignment]
    DocxRun = None  # type: ignore[misc, assignment]

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _iter_docx_runs_doc_order(paragraph: Any) -> Any:
    """Yield each `w:r` in document order, including runs nested in `w:hyperlink`.

    `paragraph.runs` only returns `w:r` that are direct children of `w:p`; hyperlink text
    lives in `w:hyperlink/w:r` and would otherwise be omitted from structured blocks.
    """
    if not Paragraph or not DocxHyperlink or not DocxRun:
        return
    for item in paragraph.iter_inner_content():
        if isinstance(item, DocxRun):
            yield item
        elif isinstance(item, DocxHyperlink):
            for inner in item.runs:
                yield inner


def _paragraph_has_any_image_from_runs(paragraph: Any, document: Any) -> bool:
    for run in _iter_docx_runs_doc_order(paragraph):
        if _images_from_run(document, run):
            return True
    return False


def _paragraph_should_skip_empty(paragraph: Any, document: Any) -> bool:
    """True when this paragraph has no extractable text, images, or textbox content."""
    if (paragraph.text or "").strip():
        return False
    if _xml_collect_wt_text(paragraph._element):
        return False
    if _paragraph_has_any_image_from_runs(paragraph, document):
        return False
    if _paragraph_has_textbox(paragraph):
        return False
    return True


def _heading_level(paragraph: Any) -> int | None:
    try:
        name = (paragraph.style.name or "").strip()
    except Exception:
        name = ""
    if not name:
        return None
    if name.lower() == "title":
        return 1
    m = re.match(r"^heading\s*(\d+)$", name, re.IGNORECASE)
    if m:
        return max(1, min(6, int(m.group(1))))
    m = re.match(r"^标题\s*(\d+)$", name)
    if m:
        return max(1, min(6, int(m.group(1))))
    return None


def _paragraph_style_is_word_toc(paragraph: Any) -> bool:
    """True when paragraph uses Word built-in TOC / table-of-figures styles (not field detection)."""
    try:
        name = (paragraph.style.name or "").strip()
    except Exception:
        name = ""
    if not name:
        return False
    if re.match(r"^TOC\s*\d+\s*$", name, re.IGNORECASE):
        return True
    if re.match(r"^目录\s*\d+\s*$", name):
        return True
    if re.match(r"^图表目录\s*\d+\s*$", name):
        return True
    nl = name.casefold()
    if nl == "toc heading" or nl.startswith("toc heading "):
        return True
    if name in ("目录标题", "图表目录标题"):
        return True
    return False


def _effective_source_region(paragraph: Any, source_region: str | None) -> str | None:
    """Preserve header/footer/textbox/notes; for body paragraphs, tag Word TOC styles as `toc`."""
    if source_region:
        return source_region
    if _paragraph_style_is_word_toc(paragraph):
        return "toc"
    return None


def _images_from_run(document: Any, run: Any) -> list[tuple[str, bytes]]:
    if not qn:
        return []
    out: list[tuple[str, bytes]] = []
    for blip in run._element.findall(".//" + qn("a:blip")):
        r_id = blip.get(qn("r:embed"))
        if not r_id:
            continue
        try:
            part = document.part.related_parts[r_id]
        except KeyError:
            continue
        blob = getattr(part, "blob", None)
        if not blob:
            continue
        mime = str(getattr(part, "content_type", None) or "image/png")
        out.append((mime, blob))
    return out


def _emit_image_asset(
    mime: str,
    blob: bytes,
    *,
    id_img: IdGen,
    legacy_images: list[dict[str, Any]],
    assets: list[dict[str, Any]],
) -> str:
    asset_id = f"ast-img-{id_img.next()}"
    b64 = base64.b64encode(blob).decode("ascii")
    legacy_images.append({
        "imageKey": asset_id,
        "contentType": mime,
        "base64": b64,
        "byteLength": len(blob),
        "sha256": sha256_bytes(blob),
    })
    assets.append({
        "id": asset_id,
        "kind": "image",
        "mimeType": mime,
        "storageUri": "",
    })
    return asset_id


def _paragraph_blocks(
    paragraph: Any,
    document: Any,
    id_gen: IdGen,
    id_img: IdGen,
    legacy_images: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    next_ro: Any,
    *,
    source_region: str | None = None,
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    region = _effective_source_region(paragraph, source_region)
    level = _heading_level(paragraph)
    buf: list[str] = []

    def flush_text_as_paragraph() -> None:
        text = "".join(buf).strip()
        buf.clear()
        if not text:
            return
        pb = paragraph_block(id_gen, text, next_ro(), source_region=region)
        if pb:
            blocks.append(pb)

    def flush_text_as_title() -> None:
        text = "".join(buf).strip()
        buf.clear()
        if not text:
            return
        tb = title_block(id_gen, text, level or 1, next_ro(), source_region=region)
        if tb:
            blocks.append(tb)

    for run in _iter_docx_runs_doc_order(paragraph):
        imgs = _images_from_run(document, run)
        if imgs:
            if level is not None:
                flush_text_as_title()
            else:
                flush_text_as_paragraph()
            for mime, blob in imgs:
                aid = _emit_image_asset(mime, blob, id_img=id_img, legacy_images=legacy_images, assets=assets)
                fb = figure_block_u(id_gen, aid, next_ro(), source_region=region)
                if fb:
                    blocks.append(fb)
        else:
            buf.append(run.text or "")

    rest = "".join(buf).strip()
    if not rest and not _paragraph_has_textbox(paragraph):
        rest = _xml_collect_wt_text(paragraph._element).strip()
    if rest:
        if level is not None:
            tb = title_block(id_gen, rest, level, next_ro(), source_region=region)
            if tb:
                blocks.append(tb)
        else:
            pb = paragraph_block(id_gen, rest, next_ro(), source_region=region)
            if pb:
                blocks.append(pb)
    return blocks


def _paragraph_has_textbox(paragraph: Any) -> bool:
    if not qn:
        return False
    return bool(paragraph._element.findall(".//" + qn("w:txbxContent")))


def _textbox_blocks_for_paragraph(
    paragraph: Any,
    document: Any,
    id_gen: IdGen,
    id_img: IdGen,
    legacy_images: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    next_ro: Any,
) -> list[dict[str, Any]]:
    if not qn or not Paragraph:
        return []
    out: list[dict[str, Any]] = []
    tx_tag = qn("w:txbxContent")
    p_tag = qn("w:p")
    seen: set[int] = set()
    for tx in paragraph._element.iter():
        if tx.tag != tx_tag:
            continue
        for cp in tx.findall(p_tag):
            cid = id(cp)
            if cid in seen:
                continue
            seen.add(cid)
            inner = Paragraph(cp, document)
            out.extend(
                _paragraph_blocks(
                    inner,
                    document,
                    id_gen,
                    id_img,
                    legacy_images,
                    assets,
                    next_ro,
                    source_region="textbox",
                )
            )
    return out


def _paragraph_visible_text_flat(paragraph: Any, document: Any) -> str:
    """Visible text for one paragraph: `w:r` in doc order (incl. hyperlink), plus `w:t` XML fallback for fields."""
    parts: list[str] = []
    for run in _iter_docx_runs_doc_order(paragraph):
        if _images_from_run(document, run):
            continue
        parts.append(run.text or "")
    s = "".join(parts).strip()
    if not s and not _paragraph_has_textbox(paragraph):
        s = _xml_collect_wt_text(paragraph._element).strip()
    return s


def _cell_visible_text(cell: Any, document: Any) -> str:
    """Join all paragraphs in a cell with newlines; same extraction as body (hyperlink + field)."""
    chunks: list[str] = []
    for para in cell.paragraphs:
        t = _paragraph_visible_text_flat(para, document)
        if t:
            chunks.append(t)
    return "\n".join(chunks).strip()


def _table_matrix(table: Any, document: Any) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in table.rows:
        cells = [_cell_visible_text(cell, document) for cell in row.cells]
        rows.append(cells)
    return [r for r in rows if any(str(c).strip() for c in r)]


def _xml_collect_wt_text(element: Any) -> str:
    parts: list[str] = []
    wt = f"{{{W_NS}}}t"
    for node in element.iter():
        if node.tag == wt and node.text:
            parts.append(node.text)
    return "".join(parts).strip()


def _blocks_from_notes_xml(
    blob: bytes | None,
    *,
    id_gen: IdGen,
    next_ro: Any,
    source_region: str,
) -> list[dict[str, Any]]:
    if not blob:
        return []
    blocks: list[dict[str, Any]] = []
    try:
        root = ET.fromstring(blob)
    except ET.ParseError:
        return []
    foot_tag = f"{{{W_NS}}}footnote"
    end_tag = f"{{{W_NS}}}endnote"
    id_attr = f"{{{W_NS}}}id"
    for child in root:
        if child.tag not in (foot_tag, end_tag):
            continue
        wid = child.get(id_attr) or ""
        if wid in ("-1", "-2"):
            continue
        txt = _xml_collect_wt_text(child)
        if not txt:
            continue
        pb = paragraph_block(id_gen, txt, next_ro(), source_region=source_region)
        if pb:
            blocks.append(pb)
    return blocks


def _iter_section_header_footer_proxies(section: Any, document: Any) -> list[tuple[str, Any]]:
    """Return (region_label, _Header|_Footer) for this section in output order."""
    out: list[tuple[str, Any]] = []
    out.append(("header", section.header))
    if section.different_first_page_header_footer:
        out.append(("first_header", section.first_page_header))
    try:
        if document.settings.odd_and_even_pages_header_footer:
            out.append(("even_header", section.even_page_header))
    except Exception:
        pass
    out.append(("footer", section.footer))
    if section.different_first_page_header_footer:
        out.append(("first_footer", section.first_page_footer))
    try:
        if document.settings.odd_and_even_pages_header_footer:
            out.append(("even_footer", section.even_page_footer))
    except Exception:
        pass
    return out


def _region_for_hdr_ftr(kind: str) -> str:
    if "footer" in kind:
        return "footer"
    return "header"


def _collect_blocks_from_container_children(
    container_el: Any,
    document: Any,
    id_gen: IdGen,
    id_img: IdGen,
    legacy_images: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    next_ro: Any,
    *,
    source_region: str | None,
) -> list[dict[str, Any]]:
    """Walk block-level children (`w:p`, `w:tbl`, nested `w:sdt` → `w:sdtContent`)."""
    blocks: list[dict[str, Any]] = []
    if not qn:
        return blocks
    for child in container_el:
        if isinstance(child, CT_P):
            para = Paragraph(child, document)
            if _paragraph_should_skip_empty(para, document):
                continue
            blocks.extend(
                _paragraph_blocks(
                    para,
                    document,
                    id_gen,
                    id_img,
                    legacy_images,
                    assets,
                    next_ro,
                    source_region=source_region,
                )
            )
            blocks.extend(
                _textbox_blocks_for_paragraph(
                    para,
                    document,
                    id_gen,
                    id_img,
                    legacy_images,
                    assets,
                    next_ro,
                )
            )
        elif isinstance(child, CT_Tbl):
            tbl = Table(child, document)
            matrix = _table_matrix(tbl, document)
            if not matrix:
                continue
            tb = table_block_nested(id_gen, matrix, next_ro(), caption=None, source_region=source_region)
            if tb:
                blocks.append(tb)
        elif child.tag == qn("w:sdt"):
            sdt_content = child.find(qn("w:sdtContent"))
            if sdt_content is not None:
                blocks.extend(
                    _collect_blocks_from_container_children(
                        sdt_content,
                        document,
                        id_gen,
                        id_img,
                        legacy_images,
                        assets,
                        next_ro,
                        source_region=source_region,
                    )
                )
    return blocks


def _hdr_ftr_story_blocks(
    hdr_ftr: Any,
    document: Any,
    id_gen: IdGen,
    id_img: IdGen,
    legacy_images: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    next_ro: Any,
    *,
    source_region: str,
) -> list[dict[str, Any]]:
    try:
        root = hdr_ftr._element
    except Exception:
        return []
    return _collect_blocks_from_container_children(
        root,
        document,
        id_gen,
        id_img,
        legacy_images,
        assets,
        next_ro,
        source_region=source_region,
    )


class DocxParser(BaseParser):
    name = "docx_python_docx"

    def parse(
        self,
        file_bytes: bytes,
        *,
        filename: str,
        file_ext: str,
        mime_type: str,
    ) -> IngestParseResult:
        if not Document or not CT_P or not CT_Tbl or not RT:
            raise RuntimeError("parser.docxUnavailable")

        doc = Document(io.BytesIO(file_bytes))
        id_gen = IdGen("u")
        id_img = IdGen("img")
        legacy_images: list[dict[str, Any]] = []
        assets: list[dict[str, Any]] = []
        page_blocks: list[dict[str, Any]] = []
        ro = 0
        warnings: list[str] = []

        def next_ro() -> int:
            nonlocal ro
            v = ro
            ro += 1
            return v

        seen_part_names: set[str] = set()

        for section in doc.sections:
            for kind, proxy in _iter_section_header_footer_proxies(section, doc):
                try:
                    part = proxy.part
                except Exception:
                    continue
                pname = str(getattr(part, "partname", "") or "")
                if not pname or pname in seen_part_names:
                    continue
                seen_part_names.add(pname)
                region = _region_for_hdr_ftr(kind)
                page_blocks.extend(
                    _hdr_ftr_story_blocks(
                        proxy,
                        doc,
                        id_gen,
                        id_img,
                        legacy_images,
                        assets,
                        next_ro,
                        source_region=region,
                    )
                )

        page_blocks.extend(
            _collect_blocks_from_container_children(
                doc.element.body,
                doc,
                id_gen,
                id_img,
                legacy_images,
                assets,
                next_ro,
                source_region=None,
            )
        )

        try:
            fn_part = doc.part.part_related_by(RT.FOOTNOTES)
        except KeyError:
            fn_part = None
        if fn_part and getattr(fn_part, "blob", None):
            page_blocks.extend(
                _blocks_from_notes_xml(
                    fn_part.blob,
                    id_gen=id_gen,
                    next_ro=next_ro,
                    source_region="footnote",
                )
            )

        try:
            en_part = doc.part.part_related_by(RT.ENDNOTES)
        except KeyError:
            en_part = None
        if en_part and getattr(en_part, "blob", None):
            page_blocks.extend(
                _blocks_from_notes_xml(
                    en_part.blob,
                    id_gen=id_gen,
                    next_ro=next_ro,
                    source_region="endnote",
                )
            )

        pages = [{"pageIndex": 0, "blocks": page_blocks}]
        parser_kind = "docx_python_docx_v3"
        doc_json = assemble_parse_document(
            file_ext="docx",
            parser_kind=parser_kind,
            source_file_name=filename or "",
            pages=pages,
            assets=assets,
            warnings=warnings,
            reading_order_policy=DOCX_READING_ORDER_POLICY,
        )
        raw = raw_text_from_pages(pages)
        legacy = legacy_docx_payload(doc_json, images=legacy_images)
        return IngestParseResult(
            raw_text=raw,
            docx=legacy,
            parse_document=doc_json,
        )
