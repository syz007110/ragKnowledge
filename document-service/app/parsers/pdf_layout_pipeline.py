"""Optional PDF layout parsing via PaddleOCR PPStructureV3 (local inference).

Requires optional deps: ``paddleocr`` (+ PaddleX runtime), ``pymupdf`` (fitz) for page geometry.
Enable with env ``PDF_LAYOUT_ENABLED=1``.

Optional: ``PDF_LAYOUT_PADDLEX_CONFIG`` points to a custom PaddleX pipeline YAML;
otherwise ``document-service/config/PP-StructureV3.yaml`` is used when present.

After each successful ``predict``, PP-Structure native JSON/Markdown are written under
``PDF_LAYOUT_EXPORT_DIR`` (or ``document-service/exports/ppstructure_native``), unless
``PDF_LAYOUT_EXPORT_NATIVE=0``.
"""

from __future__ import annotations

import logging
import json
import os
import re
import sys
from pathlib import Path
import base64
import tempfile
import time
from typing import Any

from app.parsers.ppstructure_native_mapper import (
    enrich_native_payload_with_table_res,
    unwrap_ppstructure_native_page,
)
from app.parsers.unified_builders import IdGen, assemble_parse_document, sha256_bytes

_log = logging.getLogger(__name__)

# One PPStructureV3 per process — ctor loads many models; must not run on every request.
_ppstructure_pipeline: Any | None = None


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return default


def _default_paddlex_yaml_path() -> Path:
    """document-service/config/PP-StructureV3.yaml (sibling of app/)."""
    return Path(__file__).resolve().parent.parent.parent / "config" / "PP-StructureV3.yaml"


def _resolve_paddlex_config_path() -> str | None:
    """Return path to PP-StructureV3 YAML, or None to use PaddleX package default."""
    raw = os.getenv("PDF_LAYOUT_PADDLEX_CONFIG", "").strip()
    if raw:
        p = Path(raw)
        if not p.is_file():
            _log.warning("pdf_layout: PDF_LAYOUT_PADDLEX_CONFIG not a file: %s", raw)
            return None
        return str(p.resolve())
    bundled = _default_paddlex_yaml_path()
    if bundled.is_file():
        return str(bundled.resolve())
    return None


def _get_ppstructure_pipeline() -> Any:
    global _ppstructure_pipeline
    if _ppstructure_pipeline is not None:
        return _ppstructure_pipeline
    from paddleocr import PPStructureV3  # type: ignore

    # Default enable_mkldnn=False: Paddle 3.3.x + CPU + oneDNN can hit
    # NotImplementedError in onednn_instruction (PIR attribute conversion). Opt-in via env.
    use_mkldnn = _env_bool("PDF_LAYOUT_ENABLE_MKLDNN", False)
    paddlex_yaml = _resolve_paddlex_config_path()
    kwargs: dict[str, Any] = {"enable_mkldnn": use_mkldnn}
    if paddlex_yaml:
        kwargs["paddlex_config"] = paddlex_yaml
    _ppstructure_pipeline = PPStructureV3(**kwargs)
    _log.info(
        "pdf_layout: PPStructureV3 initialized enable_mkldnn=%s paddlex_config=%s",
        use_mkldnn,
        paddlex_yaml or "(paddlex built-in default)",
    )
    return _ppstructure_pipeline


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def layout_pipeline_enabled() -> bool:
    v = os.getenv("PDF_LAYOUT_ENABLED", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _default_ppstructure_export_root() -> Path:
    """Under ``document-service/exports/ppstructure_native`` (sibling of ``app/``)."""
    return Path(__file__).resolve().parent.parent.parent / "exports" / "ppstructure_native"


def _sanitize_layout_export_stem(filename: str) -> str:
    base = Path(filename or "document").stem or "document"
    safe = re.sub(r"[^\w\-. \u4e00-\u9fff]+", "_", base, flags=re.UNICODE).strip("._")
    return (safe or "document")[:120]


def _rename_stem_prefixed_files(directory: Path, *, old_stem: str, new_prefix: str) -> None:
    """PaddleX names exports like ``{tmp_stem}_res.json`` / ``{tmp_stem}.md``; rename to ``{new_prefix}_...``."""
    if not directory.is_dir() or old_stem == new_prefix:
        return
    for p in list(directory.iterdir()):
        if not p.is_file():
            continue
        name = p.name
        if name.startswith(old_stem):
            p.rename(directory / (new_prefix + name[len(old_stem) :]))


def _export_ppstructure_pdf_artifacts(
    results: list[Any],
    *,
    source_filename: str,
    tmp_pdf_stem: str,
) -> tuple[list[str], list[str]]:
    """Write each page's PP-Structure result to JSON and Markdown via PaddleX ``save_*`` APIs.

    Controlled by ``PDF_LAYOUT_EXPORT_NATIVE`` (default: on). Base directory from
    ``PDF_LAYOUT_EXPORT_DIR`` or :func:`_default_ppstructure_export_root`.
    """
    warnings: list[str] = []
    written: list[str] = []
    if not _env_bool("PDF_LAYOUT_EXPORT_NATIVE", True):
        return written, warnings
    raw = os.getenv("PDF_LAYOUT_EXPORT_DIR", "").strip()
    base_root = Path(raw).resolve() if raw else _default_ppstructure_export_root()
    try:
        base_root.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        warnings.append(f"layout_export_mkdir:{type(e).__name__}")
        return written, warnings

    safe = _sanitize_layout_export_stem(source_filename)
    session_dir = base_root / f"{safe}_{int(time.time() * 1000)}"
    try:
        session_dir.mkdir(parents=True, exist_ok=False)
    except OSError as e:
        warnings.append(f"layout_export_session:{type(e).__name__}")
        return written, warnings

    for i, res in enumerate(results):
        page_dir = session_dir / f"page_{i:03d}"
        try:
            page_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            warnings.append(f"layout_export_page_mkdir:{i}:{type(e).__name__}")
            continue
        prefix = f"{safe}_p{i:03d}"
        try:
            save_json = getattr(res, "save_to_json", None)
            save_md = getattr(res, "save_to_markdown", None)
            if callable(save_json):
                save_json(str(page_dir))
            if callable(save_md):
                save_md(str(page_dir))
        except Exception as e:
            warnings.append(f"layout_export_save:{i}:{type(e).__name__}:{e}")
            _log.warning("pdf_layout: native export failed page_index=%s: %s", i, e)
            continue
        try:
            _rename_stem_prefixed_files(page_dir, old_stem=tmp_pdf_stem, new_prefix=prefix)
        except OSError as e:
            warnings.append(f"layout_export_rename:{i}:{type(e).__name__}")
        for pat in ("*.json", "*.md"):
            for p in sorted(page_dir.glob(pat)):
                written.append(str(p.resolve()))
    if written:
        _log.info(
            "pdf_layout: exported PP-Structure artifacts under %s (%s files)",
            session_dir,
            len(written),
        )
    return written, warnings


def _load_native_export_json_pages(
    export_paths: list[str],
    *,
    max_pages: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Load per-page native JSON exported by ``save_to_json`` ordered by page index."""
    warnings: list[str] = []
    json_paths: list[Path] = []
    for raw in export_paths:
        p = Path(str(raw or "")).resolve()
        if p.suffix.lower() == ".json":
            json_paths.append(p)
    if not json_paths:
        return [], warnings

    def _sort_key(p: Path) -> tuple[int, str]:
        m = re.match(r"^page_(\d+)$", p.parent.name)
        if m:
            try:
                return (int(m.group(1)), str(p))
            except ValueError:
                pass
        return (10**9, str(p))

    pages: list[dict[str, Any]] = []
    for p in sorted(json_paths, key=_sort_key):
        if len(pages) >= max_pages:
            break
        try:
            raw_text = p.read_text(encoding="utf-8-sig")
            obj = json.loads(raw_text)
        except Exception as e:
            warnings.append(f"layout_native_json_read:{p.name}:{type(e).__name__}")
            continue
        if not isinstance(obj, dict):
            warnings.append(f"layout_native_json_shape:{p.name}")
            continue
        pages.append(obj)
    return pages, warnings


def _open_fitz():
    try:
        import fitz  # PyMuPDF
    except Exception:
        return None
    return fitz


def _page_geometry_for_layout_pdf(
    file_bytes: bytes,
) -> list[tuple[tuple[int, int], tuple[float, float]]]:
    """Per page: (raster_wh) pixmap size Paddle uses, (pdf_wh) page size in PDF points.

    Layout/OCR models emit boxes in **raster pixel** space; we later scale bboxes to
    **PDF user space** (points) so they align with PyMuPDF / viewers.
    """
    fitz = _open_fitz()
    if not fitz:
        return []
    out: list[tuple[tuple[int, int], tuple[float, float]]] = []
    try:
        with fitz.open(stream=file_bytes, filetype="pdf") as doc:
            for pg in range(doc.page_count):
                page = doc[pg]
                r = page.rect
                pdf_wh = (float(r.width), float(r.height))
                mat = fitz.Matrix(2, 2)
                pm = page.get_pixmap(matrix=mat, alpha=False)
                if pm.width > 2000 or pm.height > 2000:
                    pm = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
                raster_wh = (int(pm.width), int(pm.height))
                out.append((raster_wh, pdf_wh))
    except Exception:
        return []
    return out


def _scale_bboxes_in_tree(obj: Any, sx: float, sy: float) -> None:
    """In-place: multiply every ``bbox`` [x0,y0,x1,y1] by sx/sy for x / y axes."""
    if isinstance(obj, dict):
        bb = obj.get("bbox")
        if isinstance(bb, (list, tuple)) and len(bb) >= 4:
            try:
                x0, y0, x1, y1 = float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])
                obj["bbox"] = [x0 * sx, y0 * sy, x1 * sx, y1 * sy]
            except (TypeError, ValueError):
                pass
        for k, v in obj.items():
            if k == "bbox":
                continue
            _scale_bboxes_in_tree(v, sx, sy)
    elif isinstance(obj, list):
        for x in obj:
            _scale_bboxes_in_tree(x, sx, sy)


def _to_jsonable(value: Any) -> Any:
    """Convert Paddle/numpy rich objects to plain JSON-compatible structures."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            out[str(k)] = _to_jsonable(v)
        return out
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(v) for v in value]
    try:
        import numpy as np  # type: ignore

        if isinstance(value, np.ndarray):
            return _to_jsonable(value.tolist())
        if isinstance(value, np.generic):
            return value.item()
    except Exception:
        pass
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace")
        except Exception:
            return repr(value)
    return repr(value)


def _bbox_union(a: list[float], b: list[float]) -> list[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _block_bbox(b: dict[str, Any]) -> list[float] | None:
    bb = b.get("bbox")
    if isinstance(bb, (list, tuple)) and len(bb) >= 4:
        try:
            return [float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])]
        except (TypeError, ValueError):
            pass
    return None


def _horizontal_overlap_ratio(a: list[float], b: list[float]) -> float:
    aw = a[2] - a[0]
    bw = b[2] - b[0]
    if aw <= 0 or bw <= 0:
        return 0.0
    inter = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    return inter / min(aw, bw)


def _mergeable_single_line_paragraph(b: dict[str, Any]) -> bool:
    """OCR often emits one block per text line; merge only those, not titles/tables."""
    if str(b.get("type") or "") != "paragraph":
        return False
    if b.get("blocks"):
        return False
    lab = str(b.get("layoutLabel") or "text").lower()
    for bad in (
        "title",
        "table",
        "figure",
        "image",
        "formula",
        "chart",
        "header",
        "footer",
        "seal",
        "footnote",
        "caption",
    ):
        if bad in lab:
            return False
    lines = b.get("lines") or []
    if not isinstance(lines, list) or len(lines) != 1:
        return False
    return _block_bbox(b) is not None


def _merge_adjacent_line_paragraphs(
    blocks: list[dict[str, Any]],
    *,
    raster_w: int,
    raster_h: int,
) -> tuple[list[dict[str, Any]], int]:
    """Merge consecutive one-line OCR paragraphs that belong to the same visual paragraph.

    Optional tuning (see also module docstring / deployment notes):

    - ``PDF_LAYOUT_MERGE_MAX_GAP_FACTOR`` (default 1.0): multiply the max vertical gap
      between lines; increase (e.g. 1.5–2.5) for large line spacing or headings.
    - ``PDF_LAYOUT_MERGE_X_TOLERANCE_FACTOR`` (default 1.0): multiply horizontal
      left-edge tolerance; increase slightly (e.g. 1.3) if merges fail on indented first lines.
    """
    if len(blocks) < 2:
        return blocks, 0
    merges = 0
    out: list[dict[str, Any]] = []
    rw = max(1, int(raster_w))
    rh = max(1, int(raster_h))
    gap_factor = max(0.1, _env_float("PDF_LAYOUT_MERGE_MAX_GAP_FACTOR", 1.0))
    x_factor = max(0.1, _env_float("PDF_LAYOUT_MERGE_X_TOLERANCE_FACTOR", 1.0))
    x_tol = max(5.0, 0.018 * float(rw)) * x_factor
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if not _mergeable_single_line_paragraph(b):
            out.append(b)
            i += 1
            continue
        cur = b
        cur_bb = _block_bbox(cur)
        if not cur_bb:
            out.append(b)
            i += 1
            continue
        j = i + 1
        while j < len(blocks):
            nxt = blocks[j]
            if not _mergeable_single_line_paragraph(nxt):
                break
            nbb = _block_bbox(nxt)
            if not nbb:
                break
            h_cur = max(1e-6, cur_bb[3] - cur_bb[1])
            h_nxt = max(1e-6, nbb[3] - nbb[1])
            line_h = max(1.0, min(h_cur, h_nxt))
            gap = nbb[1] - cur_bb[3]
            max_gap = min(0.05 * float(rh), max(10.0, 1.55 * line_h)) * gap_factor
            if gap > max_gap:
                break
            if gap < -0.55 * line_h:
                break
            if abs(nbb[0] - cur_bb[0]) > x_tol and _horizontal_overlap_ratio(cur_bb, nbb) < 0.22:
                break
            cur_lines = list(cur.get("lines") or [])
            nxt_lines = list(nxt.get("lines") or [])
            cur["lines"] = cur_lines + nxt_lines
            cur_bb = _bbox_union(cur_bb, nbb)
            cur["bbox"] = cur_bb
            merges += 1
            j += 1
        out.append(cur)
        i = j
    for ro, blk in enumerate(out):
        blk["readingOrder"] = ro
    return out, merges


def _poly_to_bbox(poly: Any) -> list[float] | None:
    pts = _poly_to_points(poly)
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))]


def _poly_to_points(poly: Any) -> list[tuple[float, float]]:
    if poly is None:
        return []
    try:
        import numpy as np  # type: ignore

        arr = np.asarray(poly)
        if arr.ndim == 2 and arr.shape[1] >= 2:
            return [(float(r[0]), float(r[1])) for r in arr]
    except Exception:
        pass
    if isinstance(poly, (list, tuple)):
        out: list[tuple[float, float]] = []
        for p in poly:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                out.append((float(p[0]), float(p[1])))
        return out
    return []


def _center_xy(poly: Any) -> tuple[float, float]:
    pts = _poly_to_points(poly)
    if not pts:
        return (0.0, 0.0)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def _parsing_item_to_plain_dict(item: Any) -> dict[str, Any] | None:
    """Turn PaddleX ``LayoutBlock`` or exported-JSON dict into a plain dict (same keys as ``save_to_json``)."""
    if item is None:
        return None
    if isinstance(item, dict):
        out = dict(item)
        bb = out.get("bbox") or out.get("box") or out.get("block_bbox")
        if bb is not None and isinstance(bb, (list, tuple)) and len(bb) >= 4:
            try:
                out["bbox"] = [float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])]
            except (TypeError, ValueError):
                pass
        return out
    label = getattr(item, "label", None)
    if label is None:
        return None
    raw_bb = getattr(item, "bbox", None)
    bbox_list: list[float] | None = None
    if raw_bb is not None:
        try:
            b = list(raw_bb)[:4]
            bbox_list = [float(b[0]), float(b[1]), float(b[2]), float(b[3])]
        except (TypeError, ValueError, IndexError):
            bbox_list = None
    content = getattr(item, "content", None)
    if content is None:
        content = ""
    out = {
        "block_label": str(label),
        "block_content": str(content),
        "text": str(content),
        "bbox": bbox_list,
        "block_bbox": bbox_list,
    }
    idx = getattr(item, "index", None)
    if idx is not None:
        out["block_id"] = idx
    oi = getattr(item, "order_index", None)
    if oi is not None:
        out["block_order"] = oi
    return out


def _sort_parsing_plain_dicts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Match reading order: ``block_order`` when present, else top-to-left bbox."""

    def sort_key(d: dict[str, Any]) -> tuple:
        o = d.get("block_order")
        if o is None:
            o = d.get("order_index")
        if o is not None:
            try:
                return (0, float(o))
            except (TypeError, ValueError):
                pass
        bb = d.get("bbox") or d.get("block_bbox") or d.get("box")
        if isinstance(bb, (list, tuple)) and len(bb) >= 4:
            try:
                return (1, float(bb[1]), float(bb[0]))
            except (TypeError, ValueError):
                pass
        return (2, 0.0, 0.0)

    return sorted(items, key=sort_key)


def _blocks_from_overall_ocr(ocr: dict[str, Any], id_gen: IdGen) -> list[dict[str, Any]]:
    texts = ocr.get("rec_texts") or []
    polys = ocr.get("rec_polys") or ocr.get("dt_polys") or []
    if not isinstance(texts, list) or not isinstance(polys, list):
        return []
    n = min(len(texts), len(polys))
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: (_center_xy(polys[i])[1], _center_xy(polys[i])[0]))
    blocks: list[dict[str, Any]] = []
    ro = 0
    for idx in order:
        t = str(texts[idx] or "").strip()
        if not t:
            continue
        bbox = _poly_to_bbox(polys[idx])
        sp: dict[str, Any] = {
            "id": f"sp-{id_gen.next()}",
            "text": t,
            "translatable": True,
        }
        ln: dict[str, Any] = {"id": f"ln-{id_gen.next()}", "spans": [sp]}
        if bbox:
            sp["bbox"] = bbox
            ln["bbox"] = bbox
        blk: dict[str, Any] = {
            "id": f"blk-{id_gen.next()}",
            "type": "paragraph",
            "readingOrder": ro,
            "lines": [ln],
            "layoutLabel": "text",
        }
        if bbox:
            blk["bbox"] = bbox
        ro += 1
        blocks.append(blk)
    return blocks


def _blocks_from_parsing_list(items: list[Any], id_gen: IdGen) -> list[dict[str, Any]]:
    """Map PaddleX layout list (``LayoutBlock`` or dict like exported JSON) to ParseDocument blocks."""
    plain: list[dict[str, Any]] = []
    for item in items:
        d = _parsing_item_to_plain_dict(item)
        if d:
            plain.append(d)
    items_sorted = _sort_parsing_plain_dicts(plain)

    blocks: list[dict[str, Any]] = []
    ro = 0
    for item in items_sorted:
        label = str(
            item.get("label")
            or item.get("block_label")
            or item.get("layout_label")
            or item.get("type")
            or "text"
        ).lower()
        bbox = item.get("bbox") or item.get("box") or item.get("block_bbox")
        if isinstance(bbox, (list, tuple)) and len(bbox) >= 4:
            bb = [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])]
        else:
            bb = None
        text = str(
            item.get("text")
            or item.get("content")
            or item.get("block_content")
            or ""
        ).strip()
        html = item.get("table_html") or item.get("html") or item.get("pred_html")
        if not html and "table" in label:
            c = str(item.get("block_content") or item.get("text") or "").strip()
            if c.startswith("<table") or "<table" in c[:200]:
                html = c
        latex = item.get("latex") or item.get("formula") or item.get("pred")
        score_raw = item.get("score")
        score: float | None = None
        try:
            if score_raw is not None:
                score = float(score_raw)
        except (TypeError, ValueError):
            score = None

        if "table" in label and html:
            rows = item.get("rows")
            if isinstance(rows, list) and rows:
                inner_id = f"blk-{id_gen.next()}"
                row_objs: list[dict[str, Any]] = []
                for ri, row in enumerate(rows):
                    if not isinstance(row, dict):
                        continue
                    cells_out: list[dict[str, Any]] = []
                    for ci, cell in enumerate(row.get("cells") or []):
                        if not isinstance(cell, dict):
                            continue
                        spans = cell.get("spans") or []
                        if not spans:
                            ct = str(cell.get("text") or "").strip()
                            if ct:
                                spans = [
                                    {
                                        "id": f"sp-{id_gen.next()}",
                                        "text": ct,
                                        "translatable": True,
                                    }
                                ]
                        cells_out.append({"id": f"c-{ri}-{ci}", "spans": spans})
                    row_objs.append({"id": f"row-{ri}", "cells": cells_out})
                cap = str(item.get("caption") or "").strip()
                children: list[dict[str, Any]] = []
                if cap:
                    sp = {
                        "id": f"sp-{id_gen.next()}",
                        "text": cap,
                        "translatable": True,
                    }
                    children.append(
                        {
                            "id": f"blk-{id_gen.next()}",
                            "type": "paragraph",
                            "readingOrder": 0,
                            "lines": [{"id": f"ln-{id_gen.next()}", "spans": [sp]}],
                        }
                    )
                children.append(
                    {
                        "id": f"blk-{id_gen.next()}",
                        "type": "table",
                        "readingOrder": len(children),
                        "rows": row_objs,
                    }
                )
                outer: dict[str, Any] = {
                    "id": f"blk-{id_gen.next()}",
                    "type": "table",
                    "readingOrder": ro,
                    "layoutLabel": "table",
                    "blocks": children,
                }
                if isinstance(html, str) and html.strip():
                    outer["tableHtml"] = html
                if bb:
                    outer["bbox"] = bb
                if score is not None:
                    outer["score"] = score
                blocks.append(outer)
                ro += 1
                continue

        if "equation" in label or "formula" in label:
            lt = str(latex or text).strip()
            if not lt:
                continue
            sp = {"id": f"sp-{id_gen.next()}", "text": lt, "translatable": False}
            blk = {
                "id": f"blk-{id_gen.next()}",
                "type": "formula",
                "readingOrder": ro,
                "layoutLabel": "equation",
                "lines": [{"id": f"ln-{id_gen.next()}", "spans": [sp]}],
            }
            if lt:
                blk["formulaLatex"] = lt
            if bb:
                blk["bbox"] = bb
            if score is not None:
                blk["score"] = score
            blocks.append(blk)
            ro += 1
            continue

        if any(k in label for k in ("figure", "image", "picture", "photo", "chart", "illustration")):
            fig: dict[str, Any] = {
                "id": f"blk-{id_gen.next()}",
                "type": "figure",
                "readingOrder": ro,
                "layoutLabel": "figure",
                "blocks": [],
            }
            if bb:
                fig["bbox"] = bb
            if score is not None:
                fig["score"] = score
            cap = str(item.get("caption") or text or "").strip()
            if cap:
                sp = {
                    "id": f"sp-{id_gen.next()}",
                    "text": cap,
                    "translatable": True,
                }
                fig["blocks"].append(
                    {
                        "id": f"blk-{id_gen.next()}",
                        "type": "paragraph",
                        "readingOrder": 0,
                        "lines": [{"id": f"ln-{id_gen.next()}", "spans": [sp]}],
                    }
                )
            blocks.append(fig)
            ro += 1
            continue

        if "title" in label or label in ("header", "heading"):
            if not text:
                continue
            sp = {
                "id": f"sp-{id_gen.next()}",
                "text": text,
                "translatable": True,
                "style": ["bold"],
            }
            blk = {
                "id": f"blk-{id_gen.next()}",
                "type": "title",
                "readingOrder": ro,
                "level": 1,
                "layoutLabel": label,
                "lines": [{"id": f"ln-{id_gen.next()}", "spans": [sp]}],
            }
            if bb:
                blk["bbox"] = bb
                sp["bbox"] = bb
                blk["lines"][0]["bbox"] = bb
            if score is not None:
                blk["score"] = score
            blocks.append(blk)
            ro += 1
            continue

        if not text:
            continue
        sp = {"id": f"sp-{id_gen.next()}", "text": text, "translatable": True}
        blk = {
            "id": f"blk-{id_gen.next()}",
            "type": "paragraph",
            "readingOrder": ro,
            "layoutLabel": label or "text",
            "lines": [{"id": f"ln-{id_gen.next()}", "spans": [sp]}],
        }
        if bb:
            blk["bbox"] = bb
            sp["bbox"] = bb
            blk["lines"][0]["bbox"] = bb
        if score is not None:
            blk["score"] = score
        blocks.append(blk)
        ro += 1
    return blocks


def _blocks_from_result_dict(res: dict[str, Any], id_gen: IdGen) -> list[dict[str, Any]]:
    for key in (
        "parsing_res_list",
        "parsing_list",
        "layout_parsing_result",
        "layout_parsing_results",
        "block_content",
    ):
        raw = res.get(key)
        if isinstance(raw, list) and raw:
            mapped = _blocks_from_parsing_list(raw, id_gen)
            if mapped:
                return mapped
    ocr = res.get("overall_ocr_res")
    if isinstance(ocr, dict):
        blocks = _blocks_from_overall_ocr(ocr, id_gen)
        if blocks:
            return blocks
    return []


def _layout_det_image_bboxes(payload: dict[str, Any]) -> list[list[float]]:
    out: list[list[float]] = []
    det = payload.get("layout_det_res")
    if not isinstance(det, dict):
        return out
    boxes = det.get("boxes")
    if not isinstance(boxes, list):
        return out
    for item in boxes:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip().lower()
        if label not in ("image", "figure", "picture", "photo", "illustration", "chart"):
            continue
        raw = item.get("coordinate") or item.get("bbox") or item.get("box")
        if not isinstance(raw, (list, tuple)) or len(raw) < 4:
            continue
        try:
            x0, y0, x1, y1 = float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3])
        except (TypeError, ValueError):
            continue
        if x1 <= x0 or y1 <= y0:
            continue
        out.append([x0, y0, x1, y1])
    return out


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0 = max(ax0, bx0)
    iy0 = max(ay0, by0)
    ix1 = min(ax1, bx1)
    iy1 = min(ay1, by1)
    iw = max(0.0, ix1 - ix0)
    ih = max(0.0, iy1 - iy0)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
    area_b = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
    denom = area_a + area_b - inter
    if denom <= 0.0:
        return 0.0
    return inter / denom


def _bbox_contains_point(bb: list[float], x: float, y: float, *, pad: float = 0.0) -> bool:
    return (bb[0] - pad) <= x <= (bb[2] + pad) and (bb[1] - pad) <= y <= (bb[3] + pad)


def _append_missing_figures_from_layout_det(
    blocks: list[dict[str, Any]],
    *,
    source: dict[str, Any] | None,
    id_gen: IdGen,
) -> int:
    if not isinstance(source, dict):
        return 0
    candidates = _layout_det_image_bboxes(source)
    if not candidates:
        return 0
    table_refs: list[tuple[str, list[float]]] = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if str(b.get("type") or "") != "table":
            continue
        bb = _block_bbox(b)
        if not bb:
            continue
        bid = str(b.get("id") or "").strip()
        if bid:
            table_refs.append((bid, bb))
    existing = [
        _block_bbox(b)
        for b in blocks
        if isinstance(b, dict) and str(b.get("type") or "") == "figure" and _block_bbox(b)
    ]
    added = 0
    for bb in candidates:
        if any(_bbox_iou(bb, e) >= 0.7 for e in existing if e):
            continue
        cx = (bb[0] + bb[2]) / 2.0
        cy = (bb[1] + bb[3]) / 2.0
        table_id = ""
        for tid, tbb in table_refs:
            if _bbox_contains_point(tbb, cx, cy, pad=2.0):
                table_id = tid
                break
        blk = {
            "id": f"blk-{id_gen.next()}",
            "type": "figure",
            "readingOrder": 0,
            "layoutLabel": "table_image" if table_id else "image",
            "bbox": bb,
            "blocks": [],
        }
        if table_id:
            blk["sourceRegion"] = "table"
            blk["parentTableId"] = table_id
        insert_idx = len(blocks)
        for j, other in enumerate(blocks):
            obb = _block_bbox(other) if isinstance(other, dict) else None
            if not obb:
                continue
            if bb[1] < obb[1]:
                insert_idx = j
                break
        blocks.insert(insert_idx, blk)
        existing.append(bb)
        added += 1
    if added > 0:
        for ro, blk in enumerate(blocks):
            if isinstance(blk, dict):
                blk["readingOrder"] = ro
    return added


def _map_results_to_pages(
    results: list[Any],
    page_geoms: list[tuple[tuple[int, int], tuple[float, float]]],
    *,
    max_pages: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    geoms = page_geoms[:max_pages]
    n_dim = len(geoms)
    if not n_dim:
        return [], ["layout_no_page_geometry"]

    if len(results) > max_pages:
        warnings.append(f"layout_truncated_pages:{len(results)}->{max_pages}")

    pages: list[dict[str, Any]] = []
    for i in range(n_dim):
        (rpx, rpy), (pdf_w, pdf_h) = geoms[i]
        id_gen = IdGen(f"p{i}")
        res: Any = None
        if i < len(results):
            res = results[i]
        elif len(results) == 1 and i == 0:
            res = results[0]
        elif len(results) == 1 and i > 0:
            if i == 1:
                warnings.append("layout_single_result_multi_page:only_first_page_mapped")
            res = {}
        else:
            res = {}
        blocks: list[dict[str, Any]] = []
        payload = unwrap_ppstructure_native_page(res)
        layout_det_source: dict[str, Any] | None = None
        if payload is not None:
            layout_det_source = payload
            enrich_native_payload_with_table_res(payload, id_gen)
            pl = payload.get("parsing_res_list")
            if isinstance(pl, list) and pl:
                blocks = _blocks_from_parsing_list(pl, id_gen)
            if not blocks:
                blocks = _blocks_from_result_dict(payload, id_gen)
        elif isinstance(res, dict):
            layout_det_source = res
            blocks = _blocks_from_result_dict(res, id_gen)
        else:
            try:
                blocks = _blocks_from_result_dict(dict(res), id_gen)
            except Exception:
                blocks = []
        if not blocks:
            inner = None
            if isinstance(res, dict):
                inner = res.get("result") or res.get("data")
            elif hasattr(res, "get"):
                inner = res.get("result") or res.get("data")
            if isinstance(inner, dict):
                if layout_det_source is None:
                    layout_det_source = inner
                blocks = _blocks_from_result_dict(inner, id_gen)
        n_added_fig = _append_missing_figures_from_layout_det(
            blocks,
            source=layout_det_source,
            id_gen=id_gen,
        )
        if n_added_fig > 0:
            warnings.append(f"layout_det_image_figures_added:{n_added_fig}")
        if _env_bool("PDF_LAYOUT_MERGE_MULTILINE_PARAGRAPHS", False) and blocks:
            n_blocks_before = len(blocks)
            blocks, n_merges = _merge_adjacent_line_paragraphs(
                blocks, raster_w=rpx, raster_h=rpy
            )
            _log.info(
                "pdf_layout: merge_multiline page_index=%s merges=%s blocks_in=%s blocks_out=%s",
                i,
                n_merges,
                n_blocks_before,
                len(blocks),
            )
            if n_merges > 0:
                warnings.append(f"layout_merged_line_paragraphs:{n_merges}")
        sx = pdf_w / float(rpx) if rpx > 0 else 1.0
        sy = pdf_h / float(rpy) if rpy > 0 else 1.0
        if sx != 1.0 or sy != 1.0:
            _scale_bboxes_in_tree(blocks, sx, sy)
        pages.append(
            {
                "pageIndex": i,
                "width": pdf_w,
                "height": pdf_h,
                "blocks": blocks,
            }
        )
    return pages, warnings


def _extract_figure_assets_from_pdf(
    file_bytes: bytes,
    pages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Crop figure bboxes from PDF into assets + embedded image payload rows."""
    fitz = _open_fitz()
    if not fitz:
        return [], [], ["layout_figure_asset_extract:fitz_unavailable"]
    assets: list[dict[str, Any]] = []
    embedded: list[dict[str, Any]] = []
    warnings: list[str] = []
    id_img = IdGen("img")
    try:
        with fitz.open(stream=file_bytes, filetype="pdf") as doc:
            for p in pages:
                if not isinstance(p, dict):
                    continue
                page_idx = int(p.get("pageIndex") or 0)
                if page_idx < 0 or page_idx >= doc.page_count:
                    continue
                page = doc[page_idx]
                page_rect = page.rect
                blocks = p.get("blocks") or []
                if not isinstance(blocks, list):
                    continue
                for blk in blocks:
                    if not isinstance(blk, dict):
                        continue
                    if str(blk.get("type") or "") != "figure":
                        continue
                    bb = blk.get("bbox")
                    if not isinstance(bb, (list, tuple)) or len(bb) < 4:
                        continue
                    try:
                        x0, y0, x1, y1 = float(bb[0]), float(bb[1]), float(bb[2]), float(bb[3])
                    except (TypeError, ValueError):
                        continue
                    if x1 <= x0 or y1 <= y0:
                        continue
                    clip = fitz.Rect(x0, y0, x1, y1) & page_rect
                    if clip.is_empty or clip.width < 2 or clip.height < 2:
                        continue
                    pm = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip, alpha=False)
                    blob = pm.tobytes("png")
                    if not blob:
                        continue
                    asset_id = f"ast-img-{id_img.next()}"
                    blk["assetRef"] = asset_id
                    assets.append(
                        {
                            "id": asset_id,
                            "kind": "image",
                            "mimeType": "image/png",
                            "storageUri": "",
                        }
                    )
                    embedded.append(
                        {
                            "imageKey": asset_id,
                            "contentType": "image/png",
                            "base64": base64.b64encode(blob).decode("ascii"),
                            "byteLength": len(blob),
                            "sha256": sha256_bytes(blob),
                        }
                    )
    except Exception as e:
        warnings.append(f"layout_figure_asset_extract:error:{type(e).__name__}")
        return [], [], warnings
    return assets, embedded, warnings


def try_parse_with_layout(file_bytes: bytes, filename: str) -> dict[str, Any] | None:
    """Run PPStructureV3 on a PDF file when optional deps are available."""
    if not layout_pipeline_enabled():
        return None
    try:
        import paddleocr  # type: ignore  # noqa: F401 — verify optional dep before work
    except Exception as imp_exc:
        _log.warning("pdf_layout: paddleocr import failed: %s", imp_exc)
        raise RuntimeError("layout_import_failed") from imp_exc

    if not file_bytes:
        return None

    max_pages = max(1, _env_int("PDF_LAYOUT_MAX_PAGES", 50))
    page_geoms = _page_geometry_for_layout_pdf(file_bytes)
    if not page_geoms:
        _log.warning("pdf_layout: pymupdf could not read page sizes (empty PDF or fitz error)")
        return None
    if len(page_geoms) > max_pages:
        page_geoms = page_geoms[:max_pages]

    tmp_path = None
    layout_tmp_stem: str | None = None
    results: Any = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        layout_tmp_stem = Path(tmp_path).stem
        with open(tmp_path, "wb") as f:
            f.write(file_bytes)

        pipeline = _get_ppstructure_pipeline()
        n_pages = len(page_geoms)
        _log.warning(
            "pdf_layout: PPStructureV3.predict starting file=%r pages=%s (CPU inference can take minutes; reduce PDF_LAYOUT_MAX_PAGES or page count)",
            filename,
            n_pages,
        )
        print(
            f"[document-service] pdf_layout: predict starting ({n_pages} page(s)) — CPU can take several minutes; wait or lower PDF_LAYOUT_MAX_PAGES.",
            file=sys.stderr,
            flush=True,
        )
        t0 = time.perf_counter()
        results = pipeline.predict(tmp_path)
        elapsed = time.perf_counter() - t0
        _log.warning(
            "pdf_layout: PPStructureV3.predict finished in %.1fs file=%r",
            elapsed,
            filename,
        )
        print(
            f"[document-service] pdf_layout: predict finished in {elapsed:.1f}s",
            file=sys.stderr,
            flush=True,
        )
    except Exception as exc:
        _log.exception("pdf_layout: PPStructureV3.predict failed (see traceback)")
        raise RuntimeError("layout_predict_failed") from exc
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if results is None:
        _log.warning("pdf_layout: predict returned None")
        return None
    if not isinstance(results, list):
        try:
            results = list(results)
        except Exception as conv_exc:
            _log.warning(
                "pdf_layout: predict returned non-list type=%s repr=%r err=%s",
                type(results),
                results,
                conv_exc,
            )
            return None
    if not results:
        _log.warning("pdf_layout: predict returned empty list")
        return None

    export_paths: list[str] = []
    export_warn: list[str] = []
    export_session_dir: str | None = None
    map_results: list[Any] = results
    map_source = "predict_results"
    try:
        export_paths, export_warn = _export_ppstructure_pdf_artifacts(
            results,
            source_filename=filename or "document.pdf",
            tmp_pdf_stem=layout_tmp_stem or "pdf",
        )
        if export_paths:
            # All paths are .../page_NNN/... under one session directory
            export_session_dir = str(Path(export_paths[0]).parent.parent.resolve())
            native_json_pages, native_warn = _load_native_export_json_pages(
                export_paths, max_pages=max_pages
            )
            export_warn.extend(native_warn)
            if native_json_pages:
                map_results = native_json_pages
                map_source = "native_export_json"
            else:
                export_warn.append("layout_native_json_empty:fallback_predict_results")
    except Exception as ex:
        export_warn.append(f"layout_export_unexpected:{type(ex).__name__}")
        _log.warning("pdf_layout: native export raised: %s", ex)

    native_page_results: list[Any] | None = None
    if _env_bool("PDF_LAYOUT_INCLUDE_NATIVE_RESULTS", True):
        native_page_results = [_to_jsonable(x) for x in map_results[:max_pages]]

    pages, warn = _map_results_to_pages(map_results, page_geoms, max_pages=max_pages)
    warn.extend(export_warn)
    block_count = sum(len(p.get("blocks") or []) for p in pages if isinstance(p, dict))
    table_count = 0
    formula_count = 0
    for p in pages:
        for b in p.get("blocks") or []:
            if not isinstance(b, dict):
                continue
            t = str(b.get("type") or "")
            if t == "table":
                table_count += 1
            elif t == "formula":
                formula_count += 1

    assets: list[dict[str, Any]] = []
    embedded_images: list[dict[str, Any]] = []
    if _env_bool("PDF_LAYOUT_EXTRACT_FIGURE_ASSETS", True):
        assets, embedded_images, fig_warn = _extract_figure_assets_from_pdf(file_bytes, pages)
        warn.extend(fig_warn)

    meta_extra = {
        "layoutStats": {
            "pageCount": len(pages),
            "blockCount": block_count,
            "tableCount": table_count,
            "formulaCount": formula_count,
        },
        "layoutBboxCoordSpace": "pdf_points",
        "layoutParseSource": "ppl_v3_native_json",
        "layoutMapSource": map_source,
        "layoutNativeResultIncluded": bool(native_page_results is not None),
        "layoutFigureAssetCount": len(assets),
    }
    if export_session_dir:
        meta_extra["layoutNativeExportDir"] = export_session_dir
    if export_paths:
        meta_extra["layoutNativeExportPaths"] = export_paths
    if native_page_results is not None:
        meta_extra["layoutNativePageResults"] = native_page_results

    doc = assemble_parse_document(
        file_ext="pdf",
        parser_kind="pdf_layout_v1",
        source_file_name=filename or "",
        pages=pages,
        assets=assets,
        warnings=warn,
        parse_route="layout",
        has_bbox=True,
        meta_extra=meta_extra,
    )
    if embedded_images:
        doc["_embeddedImages"] = embedded_images
    return doc
