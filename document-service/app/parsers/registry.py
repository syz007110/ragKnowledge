from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.parsers.docx_parser import DocxParser
from app.parsers.markdown_parser import MarkdownParser
from app.parsers.pdf_parser import PdfParser
from app.parsers.text_parser import PlainTextParser
from app.parsers.types import BaseParser, IngestParseResult
from app.parsers.xlsx_parser import XlsxParser

EXT_ALIASES = {
    "markdown": "md",
    "text": "txt",
}

MIME_TO_EXT = {
    "text/markdown": "md",
    "text/plain": "txt",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}


def _normalize_ext(value: str) -> str:
    ext = str(value or "").strip().lower().lstrip(".")
    return EXT_ALIASES.get(ext, ext)


def guess_file_ext(filename: str, explicit_ext: str = "", mime_type: str = "") -> str:
    ext = _normalize_ext(explicit_ext)
    if ext:
        return ext
    file_ext = _normalize_ext(Path(str(filename or "")).suffix)
    if file_ext:
        return file_ext
    return _normalize_ext(MIME_TO_EXT.get(str(mime_type or "").strip().lower(), "txt")) or "txt"


@dataclass
class ParserRegistry:
    _parsers: dict[str, BaseParser]
    default_parser: BaseParser

    def get_parser(self, file_ext: str) -> BaseParser:
        ext = _normalize_ext(file_ext)
        return self._parsers.get(ext, self.default_parser)


def build_default_registry() -> ParserRegistry:
    txt = PlainTextParser()
    md = MarkdownParser()
    parsers: dict[str, BaseParser] = {
        "txt": txt,
        "md": md,
        "docx": DocxParser(),
        "xlsx": XlsxParser(),
        "pdf": PdfParser(),
    }
    return ParserRegistry(_parsers=parsers, default_parser=txt)

