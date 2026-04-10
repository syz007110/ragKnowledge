from __future__ import annotations


def _split_long_paragraph(text: str, max_chunk_size: int) -> list[str]:
    words = str(text or "").split()
    if not words:
        return []
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for word in words:
        additional = len(word) if not current else len(word) + 1
        if current and current_len + additional > max_chunk_size:
            chunks.append(" ".join(current))
            current = [word]
            current_len = len(word)
            continue
        current.append(word)
        current_len += additional
    if current:
        chunks.append(" ".join(current))
    return chunks


def split_plain_text_chunks(text: str, max_chunk_size: int = 800) -> list[dict]:
    paragraphs = [item.strip() for item in str(text or "").split("\n\n") if item.strip()]
    expanded: list[str] = []
    for paragraph in paragraphs:
        if len(paragraph) <= max_chunk_size:
            expanded.append(paragraph)
            continue
        expanded.extend(_split_long_paragraph(paragraph, max_chunk_size=max_chunk_size))

    chunks: list[dict] = []
    offset = 0
    for paragraph in expanded:
        chunks.append(
            {
                "text": paragraph,
                "headingPath": [],
                "chunkType": "paragraph",
                "rowKvText": "",
                "sheetName": "",
                "tableId": "",
                "rowIndex": 0,
                "assetKeys": [],
                "startOffset": offset,
                "endOffset": offset + len(paragraph),
            }
        )
        offset += len(paragraph)
    return chunks

