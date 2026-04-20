"""PDF pre-check, optional layout parsing, and pdf2docx routing."""

import io
from docx import Document
import pytest
from fastapi import HTTPException
from pypdf import PdfWriter

from app.main import run_parse_bytes
from app.parsers.pdf_layout_pipeline import (
    _load_native_export_json_pages,
    _map_results_to_pages,
    _merge_adjacent_line_paragraphs,
)
from app.parsers.pdf_classify import PdfClassifyResult, classify_pdf_bytes, should_route_pdf2docx
from app.parsers.registry import build_default_registry
from app.parsers.unified_builders import IdGen, assemble_parse_document, paragraph_block


def _blank_pdf_bytes() -> bytes:
    w = PdfWriter()
    w.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _minimal_docx_bytes() -> bytes:
    d = Document()
    d.add_paragraph("sampletext " * 80)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def test_classify_text_like_pages(monkeypatch):
    class FakePage:
        def __init__(self, text: str):
            self._t = text

        def extract_text(self):
            return self._t

    class FakeReader:
        def __init__(self):
            long = "word " * 80
            self.pages = [FakePage(long), FakePage(long), FakePage(long)]

    monkeypatch.setattr("app.parsers.pdf_classify.PdfReader", lambda _b: FakeReader())
    r = classify_pdf_bytes(b"%PDF-fake")
    assert r is not None
    assert r.kind == "text"
    assert r.confidence >= 0.7
    assert should_route_pdf2docx(r) is True


def test_classify_scan_like_pages(monkeypatch):
    class FakePage:
        def extract_text(self):
            return ""

    class FakeReader:
        pages = [FakePage(), FakePage(), FakePage()]

    monkeypatch.setattr("app.parsers.pdf_classify.PdfReader", lambda _b: FakeReader())
    r = classify_pdf_bytes(b"%PDF-fake")
    assert r is not None
    assert r.kind == "scanned"
    assert should_route_pdf2docx(r) is False


def test_pdf_parser_non_layout_path_uses_pdf2docx(monkeypatch):
    monkeypatch.delenv("PDF_LAYOUT_ENABLED", raising=False)
    fake = PdfClassifyResult(
        kind="scanned",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=0.0,
        scan_like_ratio=1.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake)
    monkeypatch.setattr(
        "app.parsers.pdf_parser._pdf_bytes_to_docx_bytes",
        lambda _b: _minimal_docx_bytes(),
    )

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="b.pdf", file_ext="pdf", mime_type="application/pdf")
    assert out.parse_document is not None
    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfRoute") == "pdf2docx_docxparser"
    assert meta.get("pdfKind") == "scanned"
    assert meta.get("pdfFallbackFromPdf2docx") is False


def test_pdf_parser_pdf2docx_docxparser_path(monkeypatch):
    monkeypatch.delenv("PDF_LAYOUT_ENABLED", raising=False)
    monkeypatch.setenv("PDF_ROUTE_CONFIDENCE_MIN", "0.5")
    monkeypatch.setenv("PDF_TEXT_RESULT_MIN_CHARS_PER_PAGE", "1")

    fake_cls = PdfClassifyResult(
        kind="text",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=1.0,
        scan_like_ratio=0.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake_cls)
    monkeypatch.setattr(
        "app.parsers.pdf_parser._pdf_bytes_to_docx_bytes",
        lambda _b: _minimal_docx_bytes(),
    )

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="x.pdf", file_ext="pdf", mime_type="application/pdf")
    assert out.parse_document is not None
    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfRoute") == "pdf2docx_docxparser"
    assert meta.get("pdfFallbackFromPdf2docx") is False
    assert out.parse_document.get("fileExt") == "pdf"
    assert out.parse_document.get("schemaVersion") == "2.0"


def test_pdf_parser_fallback_when_pdf2docx_quality_low(monkeypatch):
    monkeypatch.delenv("PDF_LAYOUT_ENABLED", raising=False)
    monkeypatch.setenv("PDF_TEXT_RESULT_MIN_CHARS_PER_PAGE", "99999")

    fake_cls = PdfClassifyResult(
        kind="text",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=1.0,
        scan_like_ratio=0.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake_cls)
    monkeypatch.setattr(
        "app.parsers.pdf_parser._pdf_bytes_to_docx_bytes",
        lambda _b: _minimal_docx_bytes(),
    )

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    with pytest.raises(RuntimeError, match="parser\\.pdf2docxQualityLow"):
        parser.parse(_blank_pdf_bytes(), filename="x.pdf", file_ext="pdf", mime_type="application/pdf")


def _fake_layout_parse_document(filename: str) -> dict:
    id_gen = IdGen("lay")
    blk = paragraph_block(id_gen, "layout hello", 0)
    assert blk
    fig = {
        "id": f"blk-{id_gen.next()}",
        "type": "figure",
        "readingOrder": 1,
        "layoutLabel": "figure",
        "bbox": [20, 20, 120, 120],
        "assetRef": "ast-img-demo",
        "blocks": [],
    }
    pages = [{"pageIndex": 0, "width": 200, "height": 200, "blocks": [blk, fig]}]
    return assemble_parse_document(
        file_ext="pdf",
        parser_kind="pdf_layout_v1",
        source_file_name=filename,
        pages=pages,
        assets=[],
        warnings=[],
        parse_route="layout",
        has_bbox=True,
        meta_extra={"layoutStats": {"pageCount": 1, "blockCount": 1, "tableCount": 0, "formulaCount": 0}},
    )


def test_merge_adjacent_line_paragraphs_joins_close_lines():
    blocks = [
        {
            "type": "paragraph",
            "layoutLabel": "text",
            "readingOrder": 0,
            "lines": [{"id": "l1", "spans": [{"text": "第一行"}]}],
            "bbox": [10.0, 10.0, 200.0, 28.0],
        },
        {
            "type": "paragraph",
            "layoutLabel": "text",
            "readingOrder": 1,
            "lines": [{"id": "l2", "spans": [{"text": "第二行"}]}],
            "bbox": [10.0, 30.0, 200.0, 48.0],
        },
    ]
    out, n = _merge_adjacent_line_paragraphs(blocks, raster_w=400, raster_h=600)
    assert n == 1
    assert len(out) == 1
    assert len(out[0]["lines"]) == 2


def test_load_native_export_json_pages_orders_by_page_dir(tmp_path):
    p1 = tmp_path / "page_001"
    p0 = tmp_path / "page_000"
    p1.mkdir()
    p0.mkdir()
    j1 = p1 / "doc_p001_res.json"
    j0 = p0 / "doc_p000_res.json"
    md0 = p0 / "doc_p000.md"
    j1.write_text('{"res":{"parsing_res_list":[{"block_label":"text","text":"p1"}]}}', encoding="utf-8")
    j0.write_text('{"res":{"parsing_res_list":[{"block_label":"text","text":"p0"}]}}', encoding="utf-8")
    md0.write_text("# markdown only helper", encoding="utf-8")

    pages, warnings = _load_native_export_json_pages(
        [str(j1), str(md0), str(j0)],
        max_pages=5,
    )
    assert warnings == []
    assert len(pages) == 2
    assert ((pages[0].get("res") or {}).get("parsing_res_list") or [{}])[0].get("text") == "p0"
    assert ((pages[1].get("res") or {}).get("parsing_res_list") or [{}])[0].get("text") == "p1"


def test_map_results_adds_figure_from_layout_det_image_boxes():
    native_page = {
        "res": {
            "parsing_res_list": [
                {
                    "block_label": "table",
                    "block_content": "<table><tr><td>a</td></tr></table>",
                    "block_bbox": [10, 10, 90, 60],
                }
            ],
            "layout_det_res": {
                "boxes": [
                    {
                        "label": "image",
                        "score": 0.9,
                        "coordinate": [20, 20, 50, 40],
                    }
                ]
            },
        }
    }
    pages, warnings = _map_results_to_pages(
        [native_page],
        [((100, 100), (100.0, 100.0))],
        max_pages=1,
    )
    assert pages and isinstance(pages[0], dict)
    blocks = pages[0].get("blocks") or []
    figures = [b for b in blocks if isinstance(b, dict) and b.get("type") == "figure"]
    assert len(figures) == 1
    assert figures[0].get("bbox") == [20.0, 20.0, 50.0, 40.0]
    assert figures[0].get("layoutLabel") == "table_image"
    assert figures[0].get("sourceRegion") == "table"
    assert figures[0].get("parentTableId")
    assert any(str(w).startswith("layout_det_image_figures_added:") for w in warnings)


def test_pdf_parser_layout_path_when_enabled(monkeypatch):
    monkeypatch.setenv("PDF_LAYOUT_ENABLED", "1")

    fake = PdfClassifyResult(
        kind="scanned",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=0.0,
        scan_like_ratio=1.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake)
    monkeypatch.setattr(
        "app.parsers.pdf_parser.try_parse_with_layout",
        lambda _b, fn: {
            **_fake_layout_parse_document(fn),
            "_embeddedImages": [{
                "imageKey": "ast-img-demo",
                "contentType": "image/png",
                "base64": "aGVsbG8=",
                "byteLength": 5,
                "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            }],
        },
    )

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="b.pdf", file_ext="pdf", mime_type="application/pdf")
    assert out.parse_document is not None
    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfRoute") == "layout_ppstructure_v3"
    assert meta.get("pdfLayoutAttempted") is True
    assert out.parse_document.get("parseRoute") == "layout"
    assert out.parse_document.get("parserKind") == "pdf_layout_v1"
    assert meta.get("hasBbox") is True
    assert "_embeddedImages" not in out.parse_document
    assert isinstance(out.embedded_images, list) and out.embedded_images


def test_pdf_parser_layout_fallback_meta_when_pipeline_missing(monkeypatch):
    monkeypatch.setenv("PDF_LAYOUT_ENABLED", "1")
    monkeypatch.setattr(
        "app.parsers.pdf_parser.try_parse_with_layout",
        lambda _b, _fn: None,
    )
    fake = PdfClassifyResult(
        kind="scanned",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=0.0,
        scan_like_ratio=1.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake)
    monkeypatch.setattr(
        "app.parsers.pdf_parser._pdf_bytes_to_docx_bytes",
        lambda _b: _minimal_docx_bytes(),
    )

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="b.pdf", file_ext="pdf", mime_type="application/pdf")
    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfLayoutAttempted") is True
    assert meta.get("pdfLayoutFallbackReason") == "layout_pipeline_unavailable"
    assert meta.get("pdfRoute") == "pdf2docx_docxparser"


def test_pdf_parser_skips_layout_when_disabled(monkeypatch):
    monkeypatch.delenv("PDF_LAYOUT_ENABLED", raising=False)
    called = {"n": 0}

    def _track(*_a, **_k):
        called["n"] += 1
        return None

    monkeypatch.setattr("app.parsers.pdf_parser.try_parse_with_layout", _track)
    called_pdf2docx = {"n": 0}

    def _track_pdf2docx(_b):
        called_pdf2docx["n"] += 1
        return _minimal_docx_bytes()

    monkeypatch.setattr("app.parsers.pdf_parser._pdf_bytes_to_docx_bytes", _track_pdf2docx)

    fake = PdfClassifyResult(
        kind="scanned",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=0.0,
        scan_like_ratio=1.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake)

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    parser.parse(_blank_pdf_bytes(), filename="b.pdf", file_ext="pdf", mime_type="application/pdf")
    assert called["n"] == 0
    assert called_pdf2docx["n"] == 1


def test_pdf_parser_smart_route_text_skips_layout(monkeypatch):
    monkeypatch.setenv("PDF_LAYOUT_ENABLED", "1")
    monkeypatch.setenv("PDF_LAYOUT_SMART_ROUTE", "1")
    monkeypatch.setenv("PDF_LAYOUT_KINDS", "scanned")
    monkeypatch.setenv("PDF_ROUTE_CONFIDENCE_MIN", "0.5")
    monkeypatch.setenv("PDF_TEXT_RESULT_MIN_CHARS_PER_PAGE", "1")

    called = {"n": 0}

    def _track(*_a, **_k):
        called["n"] += 1
        return None

    monkeypatch.setattr("app.parsers.pdf_parser.try_parse_with_layout", _track)

    fake_cls = PdfClassifyResult(
        kind="text",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=1.0,
        scan_like_ratio=0.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake_cls)
    monkeypatch.setattr(
        "app.parsers.pdf_parser._pdf_bytes_to_docx_bytes",
        lambda _b: _minimal_docx_bytes(),
    )

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="x.pdf", file_ext="pdf", mime_type="application/pdf")
    assert called["n"] == 1
    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfRoute") == "pdf2docx_docxparser"
    assert meta.get("pdfFallbackFromPdf2docx") is False
    assert meta.get("pdfLayoutAttempted") is True


def test_pdf_parser_smart_route_scanned_still_attempts_layout(monkeypatch):
    monkeypatch.setenv("PDF_LAYOUT_ENABLED", "1")
    monkeypatch.setenv("PDF_LAYOUT_SMART_ROUTE", "1")

    called = {"n": 0}

    def _track(*_a, **_k):
        called["n"] += 1
        return {
            **_fake_layout_parse_document("b.pdf"),
            "_embeddedImages": [],
        }

    monkeypatch.setattr("app.parsers.pdf_parser.try_parse_with_layout", _track)

    fake = PdfClassifyResult(
        kind="scanned",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=0.0,
        scan_like_ratio=1.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake)

    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="b.pdf", file_ext="pdf", mime_type="application/pdf")
    assert called["n"] == 1
    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfRoute") == "layout_ppstructure_v3"
    assert meta.get("pdfLayoutSkippedByClassifier") is None


def test_pdf_parser_layout_no_exception_still_falls_back_to_pdf2docx(monkeypatch):
    monkeypatch.setenv("PDF_LAYOUT_ENABLED", "1")
    monkeypatch.setenv("PDF_ROUTE_CONFIDENCE_MIN", "0.5")
    monkeypatch.setenv("PDF_TEXT_RESULT_MIN_CHARS_PER_PAGE", "1")

    fake_cls = PdfClassifyResult(
        kind="text",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=1.0,
        scan_like_ratio=0.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake_cls)
    monkeypatch.setattr("app.parsers.pdf_parser.try_parse_with_layout", lambda _b, _fn: None)
    called = {"n": 0}

    def _track_pdf2docx(_b):
        called["n"] += 1
        return _minimal_docx_bytes()

    monkeypatch.setattr("app.parsers.pdf_parser._pdf_bytes_to_docx_bytes", _track_pdf2docx)

    parser = build_default_registry().get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="x.pdf", file_ext="pdf", mime_type="application/pdf")

    assert called["n"] == 1
    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfRoute") == "pdf2docx_docxparser"
    assert meta.get("pdfFallbackFromPdf2docx") is False
    assert meta.get("pdfLayoutAttempted") is True


def test_pdf_parser_layout_exception_can_fallback_to_pdf2docx(monkeypatch):
    monkeypatch.setenv("PDF_LAYOUT_ENABLED", "1")
    monkeypatch.setenv("PDF_ROUTE_CONFIDENCE_MIN", "0.5")
    monkeypatch.setenv("PDF_TEXT_RESULT_MIN_CHARS_PER_PAGE", "1")

    fake_cls = PdfClassifyResult(
        kind="text",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=1.0,
        scan_like_ratio=0.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake_cls)

    def _raise_layout(_b, _fn):
        raise RuntimeError("layout_predict_failed")

    monkeypatch.setattr("app.parsers.pdf_parser.try_parse_with_layout", _raise_layout)
    monkeypatch.setattr(
        "app.parsers.pdf_parser._pdf_bytes_to_docx_bytes",
        lambda _b: _minimal_docx_bytes(),
    )

    parser = build_default_registry().get_parser("pdf")
    out = parser.parse(_blank_pdf_bytes(), filename="x.pdf", file_ext="pdf", mime_type="application/pdf")

    meta = out.parse_document.get("meta") or {}
    assert meta.get("pdfRoute") == "pdf2docx_docxparser"
    assert meta.get("pdfFallbackFromPdf2docx") is False
    assert meta.get("pdfLayoutAttempted") is True
    assert meta.get("pdfLayoutFallbackReason") == "layout_exception:RuntimeError"


def test_pdf_parser_layout_exception_and_pdf2docx_failure_raises_runtime(monkeypatch):
    monkeypatch.setenv("PDF_LAYOUT_ENABLED", "1")
    fake_cls = PdfClassifyResult(
        kind="text",
        confidence=1.0,
        page_count=1,
        sampled_indices=[0],
        pages=[],
        text_like_ratio=1.0,
        scan_like_ratio=0.0,
        early_stopped=False,
    )
    monkeypatch.setattr("app.parsers.pdf_parser.classify_pdf_bytes", lambda _b: fake_cls)

    def _raise_layout(_b, _fn):
        raise RuntimeError("layout_predict_failed")

    monkeypatch.setattr("app.parsers.pdf_parser.try_parse_with_layout", _raise_layout)

    def _raise_pdf2docx(_b):
        raise RuntimeError("pdf2docx_failed")

    monkeypatch.setattr("app.parsers.pdf_parser._pdf_bytes_to_docx_bytes", _raise_pdf2docx)

    parser = build_default_registry().get_parser("pdf")
    with pytest.raises(RuntimeError, match="parser\\.pdf2docxFailed"):
        parser.parse(_blank_pdf_bytes(), filename="x.pdf", file_ext="pdf", mime_type="application/pdf")


def test_run_parse_bytes_returns_422_when_pdf2docx_fails(monkeypatch):
    monkeypatch.delenv("PDF_LAYOUT_ENABLED", raising=False)

    def _raise_pdf2docx(_b):
        raise RuntimeError("pdf2docx_failed")

    monkeypatch.setattr("app.parsers.pdf_parser._pdf_bytes_to_docx_bytes", _raise_pdf2docx)
    with pytest.raises(HTTPException) as exc:
        run_parse_bytes(
            _blank_pdf_bytes(),
            filename="x.pdf",
            explicit_ext="pdf",
            mime_type="application/pdf",
        )
    assert exc.value.status_code == 422
    detail = exc.value.detail or {}
    assert detail.get("error") == "parser_runtime"
    assert "parser.pdf2docxFailed" in str(detail.get("message") or "")
