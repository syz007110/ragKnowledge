import os
import sys
import tempfile
from typing import Any

from app.parsers.docx_parser import DocxParser
from app.parsers.pdf_classify import (
    PdfClassifyResult,
    classify_pdf_bytes,
)
from app.parsers.types import BaseParser, IngestParseResult
from app.parsers.pdf_layout_pipeline import layout_pipeline_enabled, try_parse_with_layout
from app.parsers.unified_builders import (
    raw_text_from_pages,
)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _layout_smart_route_enabled() -> bool:
    """Retained only for metadata observability."""
    return _env_bool("PDF_LAYOUT_SMART_ROUTE", False)


def _merge_pdf_meta(
    parse_document: dict[str, Any],
    *,
    classify: PdfClassifyResult | None,
    route: str,
    fallback_from_pdf2docx: bool,
) -> None:
    meta = parse_document.setdefault("meta", {})
    if not isinstance(meta, dict):
        return
    if classify:
        meta.update(classify.to_meta())
    meta["pdfRoute"] = route
    meta["pdfFallbackFromPdf2docx"] = fallback_from_pdf2docx


def _stamp_layout_fallback_meta(
    parse_document: dict[str, Any], reason: str, *, smart_route: bool = False
) -> None:
    """When PDF_LAYOUT_ENABLED=1 but we use pdf2docx instead of layout."""
    meta = parse_document.setdefault("meta", {})
    if not isinstance(meta, dict):
        return
    meta["pdfLayoutAttempted"] = True
    meta["pdfLayoutFallbackReason"] = reason
    if smart_route:
        meta["pdfLayoutSmartRoute"] = True
    print(
        "[document-service] pdf_parse layout_fallback "
        f"reason={reason} pdfRoute={meta.get('pdfRoute')!r} "
        "(install paddleocr + deps for PPStructureV3, or check PDF_LAYOUT_MAX_PAGES)",
        file=sys.stderr,
        flush=True,
    )


def _block_has_useful_layout_content(block: dict[str, Any]) -> bool:
    if not isinstance(block, dict):
        return False
    btype = str(block.get("type") or "")
    if isinstance(block.get("tableHtml"), str) and block.get("tableHtml", "").strip():
        return True
    if btype == "formula" and (
        str(block.get("formulaLatex") or "").strip()
        or block.get("lines")
    ):
        return True
    if btype == "figure" and str(block.get("assetRef") or "").strip():
        return True
    for line in block.get("lines") or []:
        if not isinstance(line, dict):
            continue
        for sp in line.get("spans") or []:
            if isinstance(sp, dict) and str(sp.get("text") or "").strip():
                return True
    if btype == "table":
        for child in block.get("blocks") or []:
            if not isinstance(child, dict):
                continue
            if str(child.get("type") or "") == "table" and child.get("rows"):
                return True
    for child in block.get("blocks") or []:
        if isinstance(child, dict) and _block_has_useful_layout_content(child):
            return True
    return False


def _layout_result_acceptable(parse_document: dict[str, Any] | None) -> bool:
    """True when layout pipeline produced something worth keeping (text and/or structure)."""
    if not parse_document or not isinstance(parse_document, dict):
        return False
    pages = parse_document.get("pages") or []
    if not isinstance(pages, list) or not pages:
        return False
    plain = raw_text_from_pages([p for p in pages if isinstance(p, dict)]).strip()
    if len(plain) >= 3:
        return True
    for page in pages:
        if not isinstance(page, dict):
            continue
        for block in page.get("blocks") or []:
            if isinstance(block, dict) and _block_has_useful_layout_content(block):
                return True
    return False


def _pdf_bytes_to_docx_bytes(pdf_bytes: bytes) -> bytes:
    try:
        from pdf2docx import Converter  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("parser.pdf2docxUnavailable") from exc
    with tempfile.TemporaryDirectory() as td:
        pdf_path = os.path.join(td, "source.pdf")
        docx_path = os.path.join(td, "out.docx")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)
        cv = Converter(pdf_path)
        try:
            cv.convert(docx_path)
        finally:
            cv.close()
        with open(docx_path, "rb") as f:
            return f.read()


def _docx_result_quality_ok(
    parse_document: dict[str, Any] | None,
    *,
    source_pdf_page_count: int,
) -> bool:
    if not parse_document or not isinstance(parse_document, dict):
        return False
    pages = parse_document.get("pages") or []
    if not isinstance(pages, list) or not pages:
        return False
    min_per_page = _env_int("PDF_TEXT_RESULT_MIN_CHARS_PER_PAGE", 80)
    plain = raw_text_from_pages([p for p in pages if isinstance(p, dict)])
    plain = plain.strip()
    if not plain:
        return False
    denom = max(1, int(source_pdf_page_count or 1))
    return (len(plain) / denom) >= min_per_page


class PdfParser(BaseParser):
    name = "pdf"

    def parse(
        self,
        file_bytes: bytes,
        *,
        filename: str,
        file_ext: str,
        mime_type: str,
    ) -> IngestParseResult:
        classify = classify_pdf_bytes(file_bytes)
        page_count = int(classify.page_count) if classify else 1

        # PDF_LAYOUT_ENABLED: always prioritize PP-StructureV3 layout path first.
        layout_enabled = layout_pipeline_enabled()
        smart_route = _layout_smart_route_enabled()

        layout_fallback_reason: str | None = None
        if layout_enabled:
            pd_layout: dict[str, Any] | None = None
            try:
                pd_layout = try_parse_with_layout(file_bytes, filename or "")
            except Exception as error:
                layout_fallback_reason = f"layout_exception:{type(error).__name__}"
            if pd_layout and _layout_result_acceptable(pd_layout):
                embedded_images = None
                if isinstance(pd_layout.get("_embeddedImages"), list):
                    embedded_images = [
                        x for x in (pd_layout.pop("_embeddedImages") or []) if isinstance(x, dict)
                    ]
                _merge_pdf_meta(
                    pd_layout,
                    classify=classify,
                    route="layout_ppstructure_v3",
                    fallback_from_pdf2docx=False,
                )
                pd_layout["fileExt"] = "pdf"
                if isinstance(pd_layout.get("meta"), dict):
                    pd_layout["meta"]["sourceFileName"] = filename or ""
                    pd_layout["meta"]["pdfLayoutAttempted"] = True
                    if smart_route:
                        pd_layout["meta"]["pdfLayoutSmartRoute"] = True
                raw = raw_text_from_pages(
                    [p for p in (pd_layout.get("pages") or []) if isinstance(p, dict)]
                )
                return IngestParseResult(
                    raw_text=raw,
                    docx=None,
                    pdf=None,
                    parse_document=pd_layout,
                    embedded_images=embedded_images,
                )
            if layout_fallback_reason is None:
                layout_fallback_reason = (
                    "layout_insufficient_content"
                    if pd_layout
                    else "layout_pipeline_unavailable"
                )

        try:
            docx_bytes = _pdf_bytes_to_docx_bytes(file_bytes)
            base_name = filename or "document.pdf"
            if base_name.lower().endswith(".pdf"):
                docx_name = base_name[:-4] + ".docx"
            else:
                docx_name = base_name + ".docx"
            docx_parser = DocxParser()
            out = docx_parser.parse(
                docx_bytes,
                filename=docx_name,
                file_ext="docx",
                mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        except Exception as error:
            raise RuntimeError("parser.pdf2docxFailed") from error

        pd = out.parse_document
        if not (pd and isinstance(pd, dict) and _docx_result_quality_ok(
            pd, source_pdf_page_count=page_count
        )):
            raise RuntimeError("parser.pdf2docxQualityLow")

        _merge_pdf_meta(
            pd,
            classify=classify,
            route="pdf2docx_docxparser",
            fallback_from_pdf2docx=False,
        )
        pd["fileExt"] = "pdf"
        if isinstance(pd.get("meta"), dict):
            pd["meta"]["sourceFileName"] = filename or ""
        if layout_enabled and layout_fallback_reason:
            _stamp_layout_fallback_meta(pd, layout_fallback_reason, smart_route=smart_route)
        return IngestParseResult(
            raw_text=out.raw_text,
            docx=out.docx,
            pdf=None,
            parse_document=pd,
        )
