"""DOCX native extended parse: header/footer, meta.readingOrderPolicy, sourceRegion."""

from __future__ import annotations

import io

import pytest

pytest.importorskip("docx")

from docx import Document

from app.parsers.docx_parser import DocxParser, _blocks_from_notes_xml
from app.parsers.unified_builders import IdGen


def test_docx_header_footer_body_and_chunkview_source_region() -> None:
    buf = io.BytesIO()
    doc = Document()
    doc.sections[0].header.paragraphs[0].text = "HDR-UNIQUE-42"
    doc.sections[0].footer.paragraphs[0].text = "FTR-UNIQUE-43"
    doc.add_paragraph("Main body text")
    doc.save(buf)
    parser = DocxParser()
    result = parser.parse(buf.getvalue(), filename="t.docx", file_ext="docx", mime_type="")
    assert "HDR-UNIQUE-42" in result.raw_text
    assert "FTR-UNIQUE-43" in result.raw_text
    assert "Main body text" in result.raw_text
    pd = result.parse_document or {}
    assert pd.get("parserKind") == "docx_python_docx_v2"
    assert pd.get("meta", {}).get("readingOrderPolicy")
    blocks = pd["pages"][0]["blocks"]
    regions = [b.get("sourceRegion") for b in blocks if isinstance(b, dict)]
    assert "header" in regions
    assert "footer" in regions
    cv = pd.get("chunkView") or {}
    cv_blocks = cv.get("blocks") or []
    hdr_chunks = [b for b in cv_blocks if b.get("sourceRegion") == "header"]
    assert hdr_chunks
    assert "HDR-UNIQUE-42" in hdr_chunks[0].get("text", "")


def test_footnote_xml_extracts_text_block() -> None:
    xml = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        b'<w:footnote w:id="0"><w:p><w:r><w:t>Note-A</w:t></w:r></w:p></w:footnote>'
        b"</w:footnotes>"
    )
    id_gen = IdGen("n")
    seq = iter(range(500))

    def nr() -> int:
        return next(seq)

    blocks = _blocks_from_notes_xml(xml, id_gen=id_gen, next_ro=nr, source_region="footnote")
    assert len(blocks) == 1
    assert blocks[0].get("sourceRegion") == "footnote"
    lines = blocks[0].get("lines") or []
    assert lines and "Note-A" in (lines[0].get("spans") or [{}])[0].get("text", "")
