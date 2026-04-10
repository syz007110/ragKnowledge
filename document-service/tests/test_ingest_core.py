from app.parsers.registry import build_default_registry, guess_file_ext
from app.parsers.types import IngestParseResult
from app.services.chunking import split_plain_text_chunks
from app.services.normalize import normalize_text


def test_guess_file_ext_prefers_explicit_extension():
    assert guess_file_ext("report.pdf", explicit_ext="DOCX", mime_type="application/pdf") == "docx"


def test_guess_file_ext_falls_back_to_filename_then_mime():
    assert guess_file_ext("manual.markdown", explicit_ext="", mime_type="text/plain") == "md"
    assert guess_file_ext("blob", explicit_ext="", mime_type="text/markdown") == "md"


def test_registry_dispatches_by_file_ext():
    registry = build_default_registry()
    parser = registry.get_parser("pdf")
    assert parser.name == "pdf"


def test_default_text_parser_returns_parse_result_shape():
    registry = build_default_registry()
    parser = registry.get_parser("txt")
    result = parser.parse(
        b"line1\nline2",
        filename="a.txt",
        file_ext="txt",
        mime_type="text/plain",
    )
    assert isinstance(result, IngestParseResult)
    assert result.raw_text == "line1\nline2"
    assert result.docx is None
    assert result.xlsx is None
    assert result.pdf is None
    assert result.parse_document is not None
    assert result.parse_document.get("schemaVersion") == "2.0"
    assert result.parse_document.get("parseRoute") == "native"


def test_normalize_text_keeps_markdown_headings_spacing():
    text = "##Title\r\n\r\nbody"
    assert normalize_text(text, file_ext="md").startswith("## Title")


def test_split_plain_text_chunks_respects_size():
    chunks = split_plain_text_chunks("a" * 10 + "\n\n" + "b" * 10, max_chunk_size=12)
    assert len(chunks) >= 2
    assert all(item["text"] for item in chunks)
