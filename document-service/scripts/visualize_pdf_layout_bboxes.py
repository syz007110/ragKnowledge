#!/usr/bin/env python3
"""Overlay ``parseDocument`` layout bboxes onto a copy of the source PDF.

Requires: PyMuPDF (``pymupdf``), same venv as document-service.

Example::

    python scripts/visualize_pdf_layout_bboxes.py ^
      --pdf D:\\tmp\\手术缝合.pdf ^
      --json D:\\tmp\\parse-response.json ^
      --out D:\\tmp\\手术缝合_layout_boxes.pdf

``--json`` can be either the full ``/internal/v1/parse`` response or a JSON file
that is only the ``parseDocument`` object.

Bboxes are scaled from ``pages[].width`` / ``pages[].height`` to the PDF page’s
``MediaBox`` (PyMuPDF ``page.rect``), so both **pixel-era** and **pdf_points**
responses from the service align with the overlay.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

try:
    import fitz  # PyMuPDF
except ImportError as e:
    print("Install pymupdf: pip install pymupdf", file=sys.stderr)
    raise SystemExit(1) from e


def _load_json(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8-sig")
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("JSON root must be an object")
    return data


def _parse_document_from_wrapper(data: dict[str, Any]) -> dict[str, Any]:
    pd = data.get("parseDocument")
    if isinstance(pd, dict):
        return pd
    return data


def _valid_bbox(bb: Any) -> bool:
    if not isinstance(bb, (list, tuple)) or len(bb) < 4:
        return False
    try:
        x0, y0, x1, y1 = (float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3]))
    except (TypeError, ValueError):
        return False
    return x1 > x0 and y1 > y0


def _iter_bboxes(
    page_obj: dict[str, Any],
    *,
    layers: set[str],
) -> Iterable[tuple[list[float], str]]:
    blocks = page_obj.get("blocks") or []
    if not isinstance(blocks, list):
        return
    for b in blocks:
        if not isinstance(b, dict):
            continue
        typ = str(b.get("layoutLabel") or b.get("type") or "block")
        if "block" in layers:
            bb = b.get("bbox")
            if _valid_bbox(bb):
                yield [float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])], f"{typ}"
        for ln in b.get("lines") or []:
            if not isinstance(ln, dict):
                continue
            if "line" in layers:
                bb = ln.get("bbox")
                if _valid_bbox(bb):
                    yield [
                        float(bb[0]),
                        float(bb[1]),
                        float(bb[2]),
                        float(bb[3]),
                    ], f"{typ}/line"
            for sp in ln.get("spans") or []:
                if not isinstance(sp, dict):
                    continue
                if "span" in layers:
                    bb = sp.get("bbox")
                    if _valid_bbox(bb):
                        yield [
                            float(bb[0]),
                            float(bb[1]),
                            float(bb[2]),
                            float(bb[3]),
                        ], f"{typ}/span"


def _draw_page(
    page: fitz.Page,
    boxes: list[tuple[list[float], str]],
    *,
    stroke_width: float,
    fill_opacity: float,
    sx: float,
    sy: float,
) -> None:
    # Colors by label prefix (block / line / span)
    for bb, label in boxes:
        r = fitz.Rect(bb[0] * sx, bb[1] * sy, bb[2] * sx, bb[3] * sy)
        if "/line" in label and "/span" not in label:
            color = (0.1, 0.6, 0.2)
        elif "/span" in label:
            color = (0.2, 0.3, 0.9)
        else:
            color = (0.95, 0.2, 0.1)
        page.draw_rect(
            r,
            color=color,
            fill=color,
            width=stroke_width,
            fill_opacity=fill_opacity,
            stroke_opacity=0.85,
            overlay=True,
        )


def main() -> None:
    ap = argparse.ArgumentParser(description="Draw parseDocument bboxes on a PDF.")
    ap.add_argument("--pdf", type=Path, required=True, help="Source PDF path")
    ap.add_argument(
        "--json",
        type=Path,
        required=True,
        help="Parse JSON (full response or parseDocument only)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output PDF path (default: <pdf-stem>_layout_boxes.pdf next to --pdf)",
    )
    ap.add_argument(
        "--layers",
        default="block,line,span",
        help="Comma-separated: block, line, span (default: all three)",
    )
    ap.add_argument("--stroke", type=float, default=0.8, help="Stroke width")
    ap.add_argument(
        "--fill-opacity",
        type=float,
        default=0.12,
        help="Fill opacity 0..1 (default 0.12)",
    )
    args = ap.parse_args()

    pdf_path: Path = args.pdf
    json_path: Path = args.json
    if not pdf_path.is_file():
        raise SystemExit(f"PDF not found: {pdf_path}")
    if not json_path.is_file():
        raise SystemExit(f"JSON not found: {json_path}")

    layers = {s.strip() for s in str(args.layers).split(",") if s.strip()}
    if not layers:
        layers = {"block", "line", "span"}

    data = _load_json(json_path)
    pd = _parse_document_from_wrapper(data)
    pages_in = pd.get("pages") or []
    if not isinstance(pages_in, list):
        raise SystemExit("parseDocument.pages must be a list")

    out_path = args.out
    if out_path is None:
        out_path = pdf_path.parent / f"{pdf_path.stem}_layout_boxes.pdf"

    doc = fitz.open(pdf_path)
    try:
        for p in pages_in:
            if not isinstance(p, dict):
                continue
            idx = int(p.get("pageIndex", -1))
            if idx < 0 or idx >= len(doc):
                print(
                    f"[warn] skip pageIndex={idx} (doc has {len(doc)} pages)",
                    file=sys.stderr,
                )
                continue
            boxes = list(_iter_bboxes(p, layers=layers))
            if not boxes:
                continue
            page_pdf = doc[idx]
            rect = page_pdf.rect
            jw = float(p.get("width") or rect.width)
            jh = float(p.get("height") or rect.height)
            sx = rect.width / jw if jw > 0 else 1.0
            sy = rect.height / jh if jh > 0 else 1.0
            _draw_page(
                page_pdf,
                boxes,
                stroke_width=args.stroke,
                fill_opacity=max(0.0, min(1.0, args.fill_opacity)),
                sx=sx,
                sy=sy,
            )

        doc.save(out_path, garbage=4, deflate=True)
    finally:
        doc.close()

    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
