from io import BytesIO

from app.parsers.types import BaseParser, IngestParseResult

try:
    from pypdf import PdfReader  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    PdfReader = None


def _normalize_line(line: str) -> str:
    return " ".join(str(line or "").strip().split())


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
        if not PdfReader:
            raise RuntimeError("parser.pdfUnavailable")
        reader = PdfReader(BytesIO(file_bytes))
        blocks: list[dict] = []
        lines_out: list[str] = []
        for page_no, page in enumerate(reader.pages, start=1):
            page_text = page.extract_text() or ""
            lines = [_normalize_line(item) for item in page_text.splitlines()]
            lines = [item for item in lines if item]
            if not lines:
                continue
            blocks.append({"type": "heading", "level": 1, "text": f"PDF 第{page_no}页"})
            for line in lines:
                blocks.append({"type": "paragraph", "text": line})
                lines_out.append(line)
        return IngestParseResult(
            raw_text="\n\n".join(lines_out),
            pdf={"blocks": blocks, "assets": [], "parserKind": "pdf_text_v1"},
        )

