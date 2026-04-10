from __future__ import annotations

import re

from app.parsers.types import BaseParser, IngestParseResult
from app.parsers.unified_builders import (
    IdGen,
    assemble_parse_document,
    paragraph_block,
    raw_text_from_pages,
    title_block,
)


class PlainTextParser(BaseParser):
    name = "txt_plain"

    def parse(
        self,
        file_bytes: bytes,
        *,
        filename: str,
        file_ext: str,
        mime_type: str,
    ) -> IngestParseResult:
        from app.parsers.unified_builders import decode_text_bytes

        text, enc_warnings = decode_text_bytes(file_bytes)
        id_gen = IdGen("u")
        blocks: list[dict] = []
        ro = 0

        def next_ro() -> int:
            nonlocal ro
            v = ro
            ro += 1
            return v

        chunks = re.split(r"\n\s*\n+", text)
        for chunk in chunks:
            line = chunk.strip()
            if not line:
                continue
            first, _, rest = line.partition("\n")
            heading_m = re.match(r"^(#{1,6})\s+(.*)$", first.strip())
            if heading_m and not rest:
                level = len(heading_m.group(1))
                tb = title_block(id_gen, heading_m.group(2).strip(), level, next_ro())
                if tb:
                    blocks.append(tb)
                continue
            if heading_m:
                tb = title_block(id_gen, heading_m.group(2).strip(), len(heading_m.group(1)), next_ro())
                if tb:
                    blocks.append(tb)
                body = rest.strip()
                if body:
                    pb = paragraph_block(id_gen, body, next_ro())
                    if pb:
                        blocks.append(pb)
                continue
            pb = paragraph_block(id_gen, line, next_ro())
            if pb:
                blocks.append(pb)

        pages = [{"pageIndex": 0, "blocks": blocks}]
        parser_kind = "txt_plain_v1"
        doc = assemble_parse_document(
            file_ext="txt",
            parser_kind=parser_kind,
            source_file_name=filename or "",
            pages=pages,
            assets=[],
            warnings=enc_warnings,
        )
        raw = raw_text_from_pages(pages) if blocks else text.strip()
        return IngestParseResult(raw_text=raw, parse_document=doc)
