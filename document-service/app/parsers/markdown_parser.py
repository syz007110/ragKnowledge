from __future__ import annotations

from app.parsers.html_unified import blocks_from_html
from app.parsers.types import BaseParser, IngestParseResult
from app.parsers.unified_builders import (
    IdGen,
    assemble_parse_document,
    decode_text_bytes,
    raw_text_from_pages,
)

try:
    import markdown  # type: ignore
except Exception:  # pragma: no cover
    markdown = None


class MarkdownParser(BaseParser):
    name = "md_markdown_py"

    def parse(
        self,
        file_bytes: bytes,
        *,
        filename: str,
        file_ext: str,
        mime_type: str,
    ) -> IngestParseResult:
        if not markdown:
            raise RuntimeError("parser.mdUnavailable")
        text, enc_warnings = decode_text_bytes(file_bytes)
        md = markdown.Markdown(extensions=["tables", "fenced_code", "nl2br"])
        html = md.convert(text)
        id_gen = IdGen("u")
        legacy_images: list = []
        page_blocks = blocks_from_html(
            html,
            id_gen,
            legacy_images=legacy_images,
            extract_embedded_images=True,
        )
        pages = [{"pageIndex": 0, "blocks": page_blocks}]
        parser_kind = "md_markdown_py_v1"
        assets_meta: list[dict] = []
        for img in legacy_images:
            if not isinstance(img, dict):
                continue
            kid = str(img.get("imageKey") or "").strip()
            if not kid:
                continue
            assets_meta.append({
                "id": kid,
                "kind": "image",
                "mimeType": str(img.get("contentType") or "image/png"),
                "storageUri": "",
            })
        doc = assemble_parse_document(
            file_ext="md",
            parser_kind=parser_kind,
            source_file_name=filename or "",
            pages=pages,
            assets=assets_meta,
            warnings=enc_warnings,
        )
        raw = raw_text_from_pages(pages)
        if not raw.strip():
            raw = text.strip()
        return IngestParseResult(
            raw_text=raw,
            parse_document=doc,
            embedded_images=legacy_images or None,
        )
