#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path


def clean_text_by_type(raw_text: str, file_ext: str) -> str:
    normalized = str(raw_text or "").replace("\r\n", "\n").replace("\x00", "")
    cleaned_lines = "\n".join(re.sub(r"\s+$", "", line) for line in normalized.split("\n"))
    cleaned_lines = re.sub(r"\n{3,}", "\n\n", cleaned_lines)
    if file_ext == "md":
        return (
            re.sub(r"^---\n[\s\S]*?\n---\n?", "", cleaned_lines, flags=re.U)
            .replace("\ufeff", "")
            .strip()
        )
    return cleaned_lines.strip()


def normalize_md_headings(text: str) -> str:
    # Align with JS: /^(#{1,6})([^\s#])/gm -> "$1 $2"
    return re.sub(r"^(#{1,6})([^\s#])", r"\1 \2", text, flags=re.M)


def split_plain_text_to_chunks(text: str, max_chunk_size: int = 800):
    normalized = str(text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n{2,}", normalized) if p.strip()]
    if not paragraphs:
        return []

    chunks = []
    buffer = ""
    start = 0

    for part in paragraphs:
        if not buffer:
            buffer = part
            continue
        if (len(buffer) + 2 + len(part)) <= max_chunk_size:
            buffer += "\n\n" + part
            continue
        chunks.append(
            {
                "text": buffer,
                "start_offset": start,
                "end_offset": start + len(buffer),
            }
        )
        # Keep the same offset logic as current backend implementation.
        start += len(buffer)
        buffer = part

    if buffer:
        chunks.append(
            {
                "text": buffer,
                "start_offset": start,
                "end_offset": start + len(buffer),
            }
        )

    return chunks


def split_long_paragraph(text: str, max_chunk_size: int):
    value = str(text or "").strip()
    if not value:
        return []
    if len(value) <= max_chunk_size:
        return [value]

    sentence_parts = [p.strip() for p in re.split(r"(?<=[。！？；.!?;])(?=\S)", value) if p.strip()]
    if not sentence_parts:
        return [value[i : i + max_chunk_size] for i in range(0, len(value), max_chunk_size)]

    out = []
    buffer = ""
    for part in sentence_parts:
        if not buffer:
            buffer = part
            continue
        if (len(buffer) + len(part)) <= max_chunk_size:
            buffer += part
            continue
        out.append(buffer)
        buffer = part
    if buffer:
        out.append(buffer)
    return out


def parse_markdown_heading(paragraph: str):
    line = str(paragraph or "").strip()
    if not line:
        return None

    m = re.match(r"^(#{1,6})\s+(.+)$", line)
    if m:
        return {"level": len(m.group(1)), "label": f"{m.group(1)} {m.group(2).strip()}"}

    m = re.match(r"^(\d+(?:\.\d+){0,5})[.、]?\s+(.+)$", line)
    if m:
        order = m.group(1)
        return {"level": max(1, len(order.split("."))), "label": f"{order} {m.group(2).strip()}"}

    m = re.match(r"^(第[一二三四五六七八九十百千万零〇0-9]+[章节篇部])\s*(.*)$", line)
    if m:
        return {"level": 1, "label": f"{m.group(1)} {m.group(2).strip()}".strip()}

    m = re.match(r"^([一二三四五六七八九十百千万零〇]+)[、.．]\s*(.+)$", line)
    if m:
        return {"level": 1, "label": f"{m.group(1)}、{m.group(2).strip()}"}

    m = re.match(r"^[（(]([一二三四五六七八九十百千万零〇0-9]+)[)）]\s*(.+)$", line)
    if m:
        return {"level": 2, "label": f"({m.group(1)}) {m.group(2).strip()}"}

    return None


def update_heading_path(stack, heading):
    level = max(1, int(heading.get("level") or 1))
    while len(stack) >= level:
        stack.pop()
    stack.append(heading.get("label", "").strip())
    return list(stack)


def split_markdown_to_chunks(text: str, max_chunk_size: int = 800):
    normalized = str(text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return []

    paragraphs = [p.strip() for p in re.split(r"\n{2,}", normalized) if p.strip()]
    if not paragraphs:
        return []

    heading_stack = []
    atomic_units = []
    pending_heading = None

    for paragraph in paragraphs:
        heading = parse_markdown_heading(paragraph)
        if heading:
            if pending_heading:
                atomic_units.append(pending_heading)
            pending_heading = {
                "parts": [paragraph],
                "heading_path": update_heading_path(heading_stack, heading),
            }
            continue

        if pending_heading:
            pending_heading["parts"].append(paragraph)
            atomic_units.append(pending_heading)
            pending_heading = None
            continue

        atomic_units.append({"parts": [paragraph], "heading_path": list(heading_stack)})

    if pending_heading:
        atomic_units.append(pending_heading)

    atomic_segments = []
    for unit in atomic_units:
        joined = "\n\n".join(unit["parts"])
        if len(joined) <= max_chunk_size:
            atomic_segments.append({"text": joined, "heading_path": unit.get("heading_path", [])})
            continue

        if len(unit["parts"]) == 1:
            for piece in split_long_paragraph(unit["parts"][0], max_chunk_size):
                atomic_segments.append({"text": piece, "heading_path": unit.get("heading_path", [])})
            continue

        # Keep heading + first body paragraph bound even if oversized.
        atomic_segments.append({"text": joined, "heading_path": unit.get("heading_path", [])})

    merged = []
    for segment in atomic_segments:
        if not merged:
            merged.append(dict(segment))
            continue
        prev = merged[-1]
        same_path = prev.get("heading_path", []) == segment.get("heading_path", [])
        can_merge = same_path and (len(prev["text"]) + 2 + len(segment["text"]) <= max_chunk_size)
        if can_merge:
            prev["text"] = prev["text"] + "\n\n" + segment["text"]
        else:
            merged.append(dict(segment))

    chunks = []
    start = 0
    for item in merged:
        text_val = item["text"]
        chunks.append(
            {
                "text": text_val,
                "heading_path": item.get("heading_path", []),
                "start_offset": start,
                "end_offset": start + len(text_val),
            }
        )
        start += len(text_val)

    return chunks


def split_text_to_chunks(text: str, file_ext: str, max_chunk_size: int = 800):
    if str(file_ext or "").lower() == "md":
        return split_markdown_to_chunks(text, max_chunk_size)
    return split_plain_text_to_chunks(text, max_chunk_size)


def sha256_text(value: str) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Preview md/txt chunk result like kbService.js")
    parser.add_argument("file_path", help="Absolute or relative path of source file")
    parser.add_argument("--max-chunk-size", type=int, default=800, help="Chunk size threshold")
    parser.add_argument(
        "--report-dir",
        default="scripts/kb-tests/results",
        help="Directory for saved report json",
    )
    parser.add_argument(
        "--save-report",
        action="store_true",
        help="Save report to --report-dir in addition to stdout",
    )
    parser.add_argument(
        "--show-text",
        action="store_true",
        help="Include full chunk text in output",
    )
    args = parser.parse_args()

    path = Path(args.file_path).resolve()
    raw = path.read_text(encoding="utf-8")
    ext = path.suffix.lower().lstrip(".")
    if ext in ("markdown",):
        ext = "md"

    cleaned = clean_text_by_type(raw, ext)
    if ext == "md":
        cleaned = normalize_md_headings(cleaned)

    chunks = split_text_to_chunks(cleaned, ext, args.max_chunk_size)

    result = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "file": str(path),
        "ext": ext,
        "max_chunk_size": args.max_chunk_size,
        "cleaned_sha256": sha256_text(cleaned),
        "cleaned_char_count": len(cleaned),
        "chunk_count": len(chunks),
        "chunks": [],
    }

    for i, c in enumerate(chunks, start=1):
        row = {
            "chunk_no": i,
            "char_count": len(c["text"]),
            "token_count_estimate": (len(c["text"]) + 3) // 4,
            "start_offset": c["start_offset"],
            "end_offset": c["end_offset"],
            "chunk_sha256": sha256_text(c["text"]),
            "heading_path": c.get("heading_path", []),
            "preview": c["text"].replace("\n", "\\n"),
        }
        if args.show_text:
            row["text"] = c["text"]
        result["chunks"].append(row)

    output_json = json.dumps(result, ensure_ascii=False, indent=2)
    print(output_json)

    if args.save_report:
        report_dir = Path(args.report_dir).resolve()
        report_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        file_stem = path.stem[:60]
        report_path = report_dir / f"{timestamp}-{file_stem}.chunk-report.json"
        report_path.write_text(output_json, encoding="utf-8")
        print(f"\n[chunk-preview] report saved: {report_path}")


if __name__ == "__main__":
    main()
