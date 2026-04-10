from dataclasses import dataclass
from typing import Any


@dataclass
class IngestParseResult:
    """parse_document: schemaVersion 2 unified parse JSON (native/layout)."""

    raw_text: str
    docx: dict[str, Any] | None = None
    xlsx: dict[str, Any] | None = None
    pdf: dict[str, Any] | None = None
    parse_document: dict[str, Any] | None = None
    # Same shape as docx legacy images; used when there is no docx wrapper (e.g. markdown).
    embedded_images: list[dict[str, Any]] | None = None


class BaseParser:
    name: str = "base"

    def parse(
        self,
        file_bytes: bytes,
        *,
        filename: str,
        file_ext: str,
        mime_type: str,
    ) -> IngestParseResult:
        raise NotImplementedError

