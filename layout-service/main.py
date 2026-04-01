"""
PDF layout sidecar: DocLayout-YOLO on page renders + PyMuPDF text alignment.
Returns JSON compatible with MKnowledge: { rawText, pdf: { blocks, assets, parserKind } }.
"""
from __future__ import annotations

import base64
import hashlib
import os
import uuid
from typing import Any

import fitz
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image

try:
    from doclayout_yolo import YOLOv10
except ImportError:
    YOLOv10 = None  # type: ignore[misc, assignment]

app = FastAPI(title="MKnowledge PDF Layout", version="0.1.0")

_model = None
_device: str | None = None

_SKIP_LABELS = frozenset({"abandon"})
_HEADING_LABELS = frozenset({"title"})
_FIGURE_LABELS = frozenset({"figure"})
_TABLE_LABELS = frozenset({"table"})


def _load_model() -> None:
    global _model, _device
    if _model is not None:
        return
    if YOLOv10 is None:
        raise RuntimeError("doclayout_yolo is not installed")
    import torch

    forced = os.getenv("LAYOUT_DEVICE", "").strip().lower()
    if forced in ("cpu", "cuda", "cuda:0"):
        _device = forced
    else:
        _device = "cuda:0" if torch.cuda.is_available() else "cpu"
    repo = os.getenv(
        "LAYOUT_MODEL_REPO",
        "juliozhao/DocLayout-YOLO-DocStructBench",
    )
    _model = YOLOv10.from_pretrained(repo)


@app.on_event("startup")
def _startup() -> None:
    if os.getenv("LAYOUT_LAZY_LOAD", "").lower() in ("1", "true", "yes"):
        return
    try:
        _load_model()
    except Exception as exc:  # noqa: BLE001
        print(f"[layout-service] model load skipped/failed: {exc}")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model_loaded": _model is not None, "device": _device}


def _ensure_model() -> None:
    if _model is None:
        try:
            _load_model()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"model_unavailable: {exc}") from exc


def _page_matrix(page: fitz.Page, max_side: int) -> fitz.Matrix:
    r = page.rect
    scale = max_side / max(r.width, r.height)
    return fitz.Matrix(scale, scale)


def _img_from_pix(pix: fitz.Pixmap) -> Image.Image:
    if pix.alpha:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _detections_for_page(
    page: fitz.Page,
    max_side: int,
    conf: float,
    imgsz: int,
) -> tuple[list[dict[str, Any]], float, float]:
    mat = _page_matrix(page, max_side)
    pix = page.get_pixmap(matrix=mat, alpha=False, colorspace=fitz.csRGB)
    try:
        img = _img_from_pix(pix)
        assert _model is not None
        det_results = _model.predict(
            source=img,
            imgsz=imgsz,
            conf=conf,
            device=_device or "cpu",
            verbose=False,
        )
        if not det_results:
            sx = page.rect.width / max(pix.width, 1)
            sy = page.rect.height / max(pix.height, 1)
            return [], sx, sy
        r0 = det_results[0]
        names = getattr(r0, "names", None) or {}
        if isinstance(names, dict):
            id_to_name = {int(k): str(v) for k, v in names.items()}
        else:
            id_to_name = {i: str(n) for i, n in enumerate(names)}

        boxes_out: list[dict[str, Any]] = []
        b = r0.boxes
        if b is None or len(b) == 0:
            sx = page.rect.width / max(pix.width, 1)
            sy = page.rect.height / max(pix.height, 1)
            return [], sx, sy
        xyxy = b.xyxy.cpu().tolist()
        cls = b.cls.cpu().tolist()
        cf = b.conf.cpu().tolist()
        for i in range(len(xyxy)):
            cid = int(cls[i])
            label = id_to_name.get(cid, str(cid))
            x0, y0, x1, y1 = xyxy[i]
            boxes_out.append(
                {
                    "label": str(label).lower(),
                    "conf": float(cf[i]),
                    "xyxy_img": [float(x0), float(y0), float(x1), float(y1)],
                }
            )
        sx = page.rect.width / max(pix.width, 1)
        sy = page.rect.height / max(pix.height, 1)
        return boxes_out, sx, sy
    finally:
        pix.close()


def _img_xyxy_to_pdf_rect(xyxy: list[float], sx: float, sy: float) -> fitz.Rect:
    x0, y0, x1, y1 = xyxy
    return fitz.Rect(x0 * sx, y0 * sy, x1 * sx, y1 * sy)


def _assign_words_to_boxes(
    words: list[tuple[Any, ...]],
    boxes_pdf: list[tuple[fitz.Rect, dict[str, Any]]],
) -> list[str]:
    out: list[str] = []
    for rect, _meta in boxes_pdf:
        inside: list[tuple[Any, ...]] = []
        for w in words:
            wx0, wy0, wx1, wy1, wt, *_rest = w
            if not wt:
                continue
            cx = (wx0 + wx1) / 2.0
            cy = (wy0 + wy1) / 2.0
            if rect.contains(fitz.Point(cx, cy)):
                inside.append(w)
        inside.sort(key=lambda t: (t[5], t[6], t[7]))
        out.append(" ".join(str(t[4]) for t in inside).strip())
    return out


def _reading_order_indices(boxes_pdf: list[tuple[fitz.Rect, dict[str, Any]]]) -> list[int]:
    indexed = list(enumerate(boxes_pdf))
    indexed.sort(key=lambda it: (it[1][0].y0, it[1][0].x0))
    return [i for i, _ in indexed]


@app.post("/v1/layout/pdf")
async def layout_pdf(file: UploadFile = File(...)) -> dict[str, Any]:
    _ensure_model()
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty_file")

    max_side = int(os.getenv("LAYOUT_MAX_PAGE_SIDE", "1024"))
    imgsz = int(os.getenv("LAYOUT_IMGSZ", "1024"))
    conf = float(os.getenv("LAYOUT_CONF", "0.25"))

    doc = fitz.open(stream=data, filetype="pdf")
    blocks: list[dict[str, Any]] = []
    assets: list[dict[str, Any]] = []
    text_parts: list[str] = []

    try:
        for page_index in range(len(doc)):
            page = doc[page_index]
            page_no = page_index + 1
            dets, sx, sy = _detections_for_page(
                page, max_side=max_side, conf=conf, imgsz=imgsz
            )
            words = page.get_text("words") or []

            candidates: list[tuple[fitz.Rect, dict[str, Any]]] = []
            for d in dets:
                lab = str(d.get("label", "")).lower()
                if lab in _SKIP_LABELS:
                    continue
                rect_pdf = _img_xyxy_to_pdf_rect(d["xyxy_img"], sx, sy)
                rect_pdf = rect_pdf & page.rect
                if rect_pdf.is_empty:
                    continue
                candidates.append((rect_pdf, {**d, "label": lab}))

            texts_for_boxes = _assign_words_to_boxes(words, candidates)
            order = _reading_order_indices(candidates)

            fig_counter = 0
            table_counter = 0
            mat = _page_matrix(page, max_side)

            for ord_i in order:
                rect_pdf, meta = candidates[ord_i]
                lab = meta["label"]
                chunk_text = texts_for_boxes[ord_i]

                if lab in _FIGURE_LABELS:
                    fig_counter += 1
                    try:
                        cpix = page.get_pixmap(
                            matrix=mat,
                            clip=rect_pdf,
                            alpha=False,
                            colorspace=fitz.csRGB,
                        )
                        png_bytes = cpix.tobytes("png")
                        cpix.close()
                    except Exception:  # noqa: BLE001
                        png_bytes = b""
                    if png_bytes:
                        b64 = base64.b64encode(png_bytes).decode("ascii")
                        key = f"layout-p{page_no}-fig{fig_counter}-{uuid.uuid4().hex[:8]}.png"
                        digest = hashlib.sha256(png_bytes).hexdigest()
                        assets.append(
                            {
                                "assetKey": key,
                                "assetType": "image",
                                "contentType": "image/png",
                                "base64": b64,
                                "text": "",
                                "sha256": digest,
                                "byteLength": len(png_bytes),
                                "sourceRef": key,
                                "sourcePageNo": page_no,
                                "meta": {
                                    "parser": "pdf_layout",
                                    "label": lab,
                                    "conf": meta.get("conf"),
                                },
                            }
                        )
                        blocks.append({"type": "image", "imageKey": key})
                    continue

                if lab in _TABLE_LABELS:
                    table_counter += 1
                    tid = f"layout-page-{page_no}-table-{table_counter}"
                    if chunk_text:
                        lines = [ln.strip() for ln in chunk_text.splitlines() if ln.strip()]
                        if not lines:
                            lines = [chunk_text]
                        header_cells = [c.strip() for c in lines[0].split() if c.strip()]
                        if len(header_cells) < 2:
                            header_cells = ["列1", "列2"]
                        blocks.append(
                            {
                                "type": "table_summary",
                                "text": f"表头: {' | '.join(header_cells)}",
                                "tableId": tid,
                            }
                        )
                        data_lines = lines[1:] if len(lines) > 1 else lines[:1]
                        for ri, row_line in enumerate(data_lines):
                            cells = [c.strip() for c in row_line.split() if c.strip()]
                            parts: list[str] = []
                            for j, cell in enumerate(cells):
                                hdr = (
                                    header_cells[j]
                                    if j < len(header_cells)
                                    else f"列{j + 1}"
                                )
                                if cell:
                                    parts.append(f"{hdr}: {cell}")
                            row_kv = "; ".join(parts)
                            if row_kv:
                                blocks.append(
                                    {
                                        "type": "table_row",
                                        "text": row_kv,
                                        "rowKvText": row_kv,
                                        "tableId": tid,
                                        "rowIndex": ri + 1,
                                    }
                                )
                        text_parts.append(chunk_text)
                    continue

                if lab in _HEADING_LABELS:
                    if chunk_text:
                        blocks.append({"type": "heading", "level": 1, "text": chunk_text})
                        text_parts.append(chunk_text)
                    continue

                if chunk_text:
                    blocks.append({"type": "paragraph", "text": chunk_text})
                    text_parts.append(chunk_text)
    finally:
        doc.close()

    raw_text = "\n\n".join(t for t in text_parts if t)
    if not blocks:
        raise HTTPException(status_code=422, detail="no_blocks_produced")

    return {
        "parserKind": "pdf_layout_v1",
        "rawText": raw_text,
        "pdf": {
            "parserKind": "pdf_layout_v1",
            "blocks": blocks,
            "assets": assets,
        },
    }
