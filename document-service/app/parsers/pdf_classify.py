"""Lightweight PDF pre-check: sample pages, classify text-like vs scan-like without full render."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any

try:
    from pypdf import PdfReader  # type: ignore
except Exception:  # pragma: no cover
    PdfReader = None


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


def _chars_and_alnum_ratio(text: str) -> tuple[int, float]:
    """Effective chars (no whitespace) and alnum / len ratio."""
    t = "".join(str(text or "").split())
    if not t:
        return 0, 0.0
    alnum = sum(1 for c in t if c.isalnum())
    return len(t), alnum / len(t)


def _sample_page_indices(page_count: int) -> list[int]:
    """0-based page indices to probe (inclusive)."""
    if page_count <= 0:
        return []
    if page_count <= 3:
        return list(range(page_count))
    if page_count <= 20:
        mid = page_count // 2
        return sorted({0, mid, page_count - 1})
    return sorted(
        {
            0,
            max(0, page_count // 4 - 1),
            page_count // 2,
            max(0, (3 * page_count) // 4 - 1),
            page_count - 1,
        }
    )


@dataclass
class PageProbe:
    page_index: int
    chars: int
    alnum_ratio: float
    text_like: bool
    scan_like: bool


@dataclass
class PdfClassifyResult:
    kind: str  # text | scanned | mixed
    confidence: float
    page_count: int
    sampled_indices: list[int]
    pages: list[PageProbe] = field(default_factory=list)
    text_like_ratio: float = 0.0
    scan_like_ratio: float = 0.0
    early_stopped: bool = False

    def to_meta(self) -> dict[str, Any]:
        return {
            "pdfKind": self.kind,
            "pdfClassifierConfidence": round(self.confidence, 4),
            "pdfPageCount": self.page_count,
            "pdfSampledPageIndexes": list(self.sampled_indices),
            "pdfTextLikeRatio": round(self.text_like_ratio, 4),
            "pdfScanLikeRatio": round(self.scan_like_ratio, 4),
            "pdfClassifierEarlyStop": self.early_stopped,
        }


def classify_pdf_bytes(file_bytes: bytes) -> PdfClassifyResult | None:
    """Return None if pypdf unavailable or PDF unreadable."""
    if not PdfReader:
        return None
    try:
        reader = PdfReader(BytesIO(file_bytes))
        page_count = len(reader.pages)
    except Exception:
        return None

    chars_high = _env_int("PDF_TEXT_CHARS_HIGH", 200)
    chars_low = _env_int("PDF_TEXT_CHARS_LOW", 40)
    alnum_min_text = _env_float("PDF_TEXT_ALNUM_MIN", 0.5)

    indices = _sample_page_indices(page_count)
    probes: list[PageProbe] = []
    early_stopped = False

    for i, idx in enumerate(indices):
        try:
            page = reader.pages[idx]
            raw = page.extract_text() or ""
        except Exception:
            raw = ""
        chars, ar = _chars_and_alnum_ratio(raw)
        text_like = chars >= chars_high and ar >= alnum_min_text
        scan_like = chars <= chars_low
        probes.append(
            PageProbe(
                page_index=idx,
                chars=chars,
                alnum_ratio=ar,
                text_like=text_like,
                scan_like=scan_like,
            )
        )
        if i >= 2 and len(probes) >= 3:
            first_three = probes[-3:]
            if all(p.text_like for p in first_three) or all(p.scan_like for p in first_three):
                early_stopped = True
                break

    if not probes:
        return PdfClassifyResult(
            kind="mixed",
            confidence=0.0,
            page_count=page_count,
            sampled_indices=[],
            pages=[],
            text_like_ratio=0.0,
            scan_like_ratio=0.0,
            early_stopped=False,
        )

    n = len(probes)
    text_like_ratio = sum(1 for p in probes if p.text_like) / n
    scan_like_ratio = sum(1 for p in probes if p.scan_like) / n

    if text_like_ratio >= 0.7:
        kind = "text"
    elif scan_like_ratio >= 0.7:
        kind = "scanned"
    else:
        kind = "mixed"

    confidence = max(text_like_ratio, scan_like_ratio)
    sampled = [p.page_index for p in probes]
    return PdfClassifyResult(
        kind=kind,
        confidence=confidence,
        page_count=page_count,
        sampled_indices=sampled,
        pages=probes,
        text_like_ratio=text_like_ratio,
        scan_like_ratio=scan_like_ratio,
        early_stopped=early_stopped,
    )


def should_route_pdf2docx(result: PdfClassifyResult | None) -> bool:
    """True when pre-check says high-confidence text PDF."""
    if result is None:
        return False
    min_conf = _env_float("PDF_ROUTE_CONFIDENCE_MIN", 0.75)
    return result.kind == "text" and result.confidence >= min_conf
