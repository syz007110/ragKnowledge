from __future__ import annotations

import logging
import os
import sys
import zipfile
from pathlib import Path


def _load_env_file(path: Path, *, override: bool) -> None:
    """Parse KEY=VAL lines (stdlib only; same role as python-dotenv for our .env files)."""
    if not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        if not key:
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        if override:
            os.environ[key] = val
        elif key not in os.environ:
            os.environ[key] = val


def _bootstrap_env() -> None:
    """Load repo ``backend/.env`` then ``document-service/.env`` (override)."""
    here = Path(__file__).resolve().parent
    service_root = here.parent
    repo_root = service_root.parent
    _load_env_file(repo_root / "backend" / ".env", override=False)
    _load_env_file(service_root / ".env", override=True)


_bootstrap_env()

from fastapi import FastAPI, File, Header, HTTPException, UploadFile

from app.parse_errors import ParseErrorCode, raise_parse_http
from app.parsers.registry import build_default_registry, guess_file_ext
from app.parsers.types import IngestParseResult
from app.schemas import (
    ChunkRequest,
    ChunkResponse,
    CleanedDocumentResponse,
    CleanParseRequest,
    NormalizeRequest,
    NormalizeResponse,
    ParseResponseModel,
    ParseResultModel,
    PlainFromPagesRequest,
    PlainFromPagesResponse,
)
from app.services.chunking import split_plain_text_chunks
from app.parsers.unified_builders import raw_text_from_pages
from app.services.clean_structured import clean_parse_document
from app.services.image_payloads import build_embedded_image_payloads
from app.services.normalize import normalize_text
from app.services.structured_chunking import split_structured_blocks

app = FastAPI(title="MKnowledge Document Service", version="0.1.0")
registry = build_default_registry()
_log = logging.getLogger(__name__)


@app.on_event("startup")
def _log_pdf_layout_env_on_startup() -> None:
    """Confirm ``backend/.env`` was read (needs restart after editing)."""
    from app.parsers.pdf_layout_pipeline import layout_pipeline_enabled

    rr = Path(__file__).resolve().parent.parent.parent
    be = rr / "backend" / ".env"
    enabled = layout_pipeline_enabled()
    raw = os.getenv("PDF_LAYOUT_ENABLED")
    smart = os.getenv("PDF_LAYOUT_SMART_ROUTE")
    kinds = os.getenv("PDF_LAYOUT_KINDS")
    # Uvicorn often hides app logger INFO; stderr print always shows in the console.
    line = (
        f"[document-service] PDF_LAYOUT_ENABLED={raw!r} "
        f"layout_pipeline_enabled={enabled} "
        f"PDF_LAYOUT_SMART_ROUTE={smart!r} "
        f"PDF_LAYOUT_KINDS={kinds!r} "
        f"backend_env_file={be} exists={be.is_file()}"
    )
    print(line, file=sys.stderr, flush=True)
    _log.warning("%s", line)


# Empty body is invalid for binary formats (txt/md may be legitimately empty).
_BINARY_PARSE_EXTS = frozenset({"docx", "xlsx", "pdf"})


def run_parse_bytes(
    file_bytes: bytes,
    *,
    filename: str = "",
    explicit_ext: str = "",
    mime_type: str = "",
) -> tuple[IngestParseResult, str, str]:
    ext = guess_file_ext(filename, explicit_ext=explicit_ext, mime_type=mime_type)
    if len(file_bytes) == 0 and ext in _BINARY_PARSE_EXTS:
        raise_parse_http(
            status_code=400,
            code=ParseErrorCode.EMPTY_PAYLOAD,
            message="empty file body for binary format",
        )
    parser = registry.get_parser(ext)
    try:
        result = parser.parse(
            file_bytes,
            filename=filename,
            file_ext=ext,
            mime_type=mime_type,
        )
    except RuntimeError as error:
        raise_parse_http(
            status_code=422,
            code=ParseErrorCode.PARSER_RUNTIME,
            message=str(error) or ParseErrorCode.PARSER_RUNTIME,
            from_exc=error,
        )
    except (ValueError, OSError, UnicodeError, zipfile.BadZipFile) as error:
        raise_parse_http(
            status_code=422,
            code=ParseErrorCode.PARSE_FAILED,
            message=str(error) or ParseErrorCode.PARSE_FAILED,
            from_exc=error,
        )
    except Exception as error:
        _log.exception("parse_unexpected")
        raise_parse_http(
            status_code=500,
            code=ParseErrorCode.INTERNAL,
            message="unexpected parse failure",
            from_exc=error,
        )
    parser_kind = (
        str((result.parse_document or {}).get("parserKind") or "").strip()
        or f"{parser.name}_v1"
    )
    return result, ext, parser_kind


def _require_internal_auth(x_internal_api_key: str | None) -> None:
    expected = str(os.getenv("KB_DOCUMENT_SERVICE_API_KEY", "")).strip()
    if not expected:
        return
    if str(x_internal_api_key or "").strip() != expected:
        raise HTTPException(status_code=401, detail="unauthorized_internal_api")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "document-service"}


@app.post("/internal/v1/parse", response_model=ParseResponseModel)
async def parse_file(
    file: UploadFile = File(...),
    fileExt: str = "",
    x_internal_api_key: str | None = Header(default=None),
) -> ParseResponseModel:
    _require_internal_auth(x_internal_api_key)
    payload = await file.read()
    result, _, _ = run_parse_bytes(
        payload,
        filename=file.filename or "",
        explicit_ext=fileExt,
        mime_type=file.content_type or "",
    )
    try:
        embedded = build_embedded_image_payloads(result)
    except Exception as error:
        _log.exception("embedded_image_payloads_failed")
        raise_parse_http(
            status_code=500,
            code=ParseErrorCode.IMAGE_PAYLOAD_BUILD,
            message="failed to build embedded image payloads",
            from_exc=error,
        )
    return ParseResponseModel(
        parseDocument=dict(result.parse_document or {}),
        embeddedImagePayloadsEncoding="base64",
        embeddedImagePayloads=embedded,
    )


@app.post("/internal/v1/normalize", response_model=NormalizeResponse)
def normalize_body(
    request: NormalizeRequest,
    x_internal_api_key: str | None = Header(default=None),
) -> NormalizeResponse:
    _require_internal_auth(x_internal_api_key)
    return NormalizeResponse(cleanedText=normalize_text(request.text, file_ext=request.fileExt))


@app.post("/internal/v1/plain-from-pages", response_model=PlainFromPagesResponse)
def plain_from_pages(
    request: PlainFromPagesRequest,
    x_internal_api_key: str | None = Header(default=None),
) -> PlainFromPagesResponse:
    """Flatten translatable text from pages tree (same as ingest pipeline plain-text path)."""
    _require_internal_auth(x_internal_api_key)
    return PlainFromPagesResponse(plainText=raw_text_from_pages(request.pages or []))


@app.post("/internal/v1/clean", response_model=CleanedDocumentResponse)
def clean_parse_body(
    request: CleanParseRequest,
    x_internal_api_key: str | None = Header(default=None),
) -> CleanedDocumentResponse:
    """Produce CleanedDocument from ParseDocument (drop header/footer, filter assets, headingPath)."""
    _require_internal_auth(x_internal_api_key)
    pd = request.parseDocument or {}
    if not isinstance(pd, dict) or not pd:
        raise HTTPException(status_code=400, detail="parseDocument_required")
    out = clean_parse_document(pd)
    return CleanedDocumentResponse(**out)


@app.post("/internal/v1/chunk", response_model=ChunkResponse)
def chunk_body(
    request: ChunkRequest,
    x_internal_api_key: str | None = Header(default=None),
) -> ChunkResponse:
    _require_internal_auth(x_internal_api_key)
    max_chunk_size = max(200, int(request.maxChunkSize or 800))
    if str(request.mode or "").lower() == "structured":
        chunks = split_structured_blocks(request.blocks, max_chunk_size=max_chunk_size)
    else:
        chunks = split_plain_text_chunks(request.text, max_chunk_size=max_chunk_size)
    return ChunkResponse(chunks=chunks)


@app.post("/internal/v1/pipeline/ingest", response_model=ParseResultModel)
async def pipeline_ingest(
    file: UploadFile = File(...),
    fileExt: str = "",
    maxChunkSize: int = 800,
    x_internal_api_key: str | None = Header(default=None),
) -> ParseResultModel:
    _require_internal_auth(x_internal_api_key)
    payload = await file.read()
    ingested, ext, parser_kind = run_parse_bytes(
        payload,
        filename=file.filename or "",
        explicit_ext=fileExt,
        mime_type=file.content_type or "",
    )
    cleaned_text = normalize_text(ingested.raw_text, file_ext=ext)
    blocks: list = []
    pd = ingested.parse_document
    cleaned_doc_for_text: dict | None = None
    if pd and isinstance(pd, dict) and (pd.get("pages") or pd.get("chunkView")):
        try:
            cleaned_doc_for_text = clean_parse_document(pd)
            blocks = (cleaned_doc_for_text.get("chunkView") or {}).get("blocks") or []
        except Exception as error:
            _log.exception("pipeline_clean_failed")
            raise_parse_http(
                status_code=500,
                code=ParseErrorCode.INTERNAL,
                message="clean structured document failed",
                from_exc=error,
            )
    elif pd and isinstance(pd.get("chunkView"), dict):
        blocks = pd["chunkView"].get("blocks") or []
    if not blocks and ingested.docx and isinstance(ingested.docx, dict):
        blocks = ingested.docx.get("blocks") or []
    if not blocks and ingested.xlsx and isinstance(ingested.xlsx, dict):
        blocks = ingested.xlsx.get("blocks") or []
    if not blocks and ingested.pdf and isinstance(ingested.pdf, dict):
        blocks = ingested.pdf.get("blocks") or []

    if cleaned_doc_for_text and (cleaned_doc_for_text.get("pages") or []):
        cleaned_text = normalize_text(
            raw_text_from_pages(cleaned_doc_for_text["pages"]),
            file_ext=ext,
        )

    try:
        if blocks:
            chunks = split_structured_blocks(blocks, max_chunk_size=max(200, int(maxChunkSize or 800)))
        else:
            chunks = split_plain_text_chunks(cleaned_text, max_chunk_size=max(200, int(maxChunkSize or 800)))
    except Exception as error:
        _log.exception("pipeline_chunk_failed")
        raise_parse_http(
            status_code=500,
            code=ParseErrorCode.INTERNAL,
            message="chunking failed after parse",
            from_exc=error,
        )

    return ParseResultModel(
        rawText=cleaned_text,
        docx=ingested.docx,
        xlsx=ingested.xlsx,
        pdf=ingested.pdf,
        parseDocument=ingested.parse_document,
        chunks=chunks,
        parserKind=parser_kind,
        fileExt=ext,
    )

