from __future__ import annotations

from app.services.chunking import split_plain_text_chunks


def split_structured_blocks(blocks: list[dict], max_chunk_size: int = 800) -> list[dict]:
    safe_blocks = blocks if isinstance(blocks, list) else []
    heading_stack: list[str] = []
    raw_segments: list[dict] = []
    pending_assets: list[str] = []

    for block in safe_blocks:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "")
        if block_type == "image" and block.get("imageKey"):
            key = str(block.get("imageKey")).strip()
            if key:
                pending_assets.append(key)
            continue

        text = str(block.get("text") or "").strip()
        if not text:
            continue

        if block_type == "heading":
            level = max(1, int(block.get("level") or 1))
            while len(heading_stack) >= level:
                heading_stack.pop()
            heading_stack.append(text)

        segment = {
            "text": text,
            "headingPath": list(heading_stack),
            "chunkType": "heading" if block_type == "heading" else (block_type or "paragraph"),
            "rowKvText": str(block.get("rowKvText") or ""),
            "sheetName": str(block.get("sheetName") or ""),
            "tableId": str(block.get("tableId") or ""),
            "rowIndex": int(block.get("rowIndex") or 0),
            "assetKeys": pending_assets[:],
        }
        pending_assets = []
        raw_segments.append(segment)

    expanded: list[dict] = []
    for segment in raw_segments:
        if len(segment["text"]) <= max_chunk_size:
            expanded.append(segment)
            continue
        parts = split_plain_text_chunks(segment["text"], max_chunk_size=max_chunk_size)
        for index, part in enumerate(parts):
            expanded.append(
                {
                    **segment,
                    "text": part["text"],
                    "assetKeys": segment["assetKeys"] if index == 0 else [],
                    "rowKvText": segment["rowKvText"] if index == 0 else "",
                }
            )

    result: list[dict] = []
    offset = 0
    for segment in expanded:
        result.append(
            {
                **segment,
                "startOffset": offset,
                "endOffset": offset + len(segment["text"]),
            }
        )
        offset += len(segment["text"])
    return result

