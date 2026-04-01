#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def load_report(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "chunks" not in data:
        raise ValueError(f"Invalid report format: {path}")
    return data


def index_by_chunk_no(chunks):
    out = {}
    for c in chunks:
        no = c.get("chunk_no")
        if no is None:
            continue
        out[int(no)] = c
    return out


def main():
    parser = argparse.ArgumentParser(description="Compare two chunk report json files")
    parser.add_argument("expected_report", help="Expected/offline report json path")
    parser.add_argument("actual_report", help="Actual/online report json path")
    args = parser.parse_args()

    expected_path = Path(args.expected_report).resolve()
    actual_path = Path(args.actual_report).resolve()
    expected = load_report(expected_path)
    actual = load_report(actual_path)

    expected_chunks = index_by_chunk_no(expected.get("chunks", []))
    actual_chunks = index_by_chunk_no(actual.get("chunks", []))

    all_chunk_nos = sorted(set(expected_chunks.keys()) | set(actual_chunks.keys()))
    diffs = []
    keys_to_compare = [
        "char_count",
        "start_offset",
        "end_offset",
        "chunk_sha256",
    ]

    for no in all_chunk_nos:
        e = expected_chunks.get(no)
        a = actual_chunks.get(no)
        if e is None:
            diffs.append(f"chunk_no={no}: missing in expected")
            continue
        if a is None:
            diffs.append(f"chunk_no={no}: missing in actual")
            continue
        for k in keys_to_compare:
            ev = e.get(k)
            av = a.get(k)
            if ev != av:
                diffs.append(f"chunk_no={no}: {k} expected={ev} actual={av}")

    summary = {
        "expected_report": str(expected_path),
        "actual_report": str(actual_path),
        "expected_chunk_count": expected.get("chunk_count"),
        "actual_chunk_count": actual.get("chunk_count"),
        "chunk_count_match": expected.get("chunk_count") == actual.get("chunk_count"),
        "diff_count": len(diffs),
        "diffs": diffs,
    }

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
