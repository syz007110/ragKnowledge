"""Structured errors for parse endpoints (HTTPException.detail as JSON object)."""

from __future__ import annotations

from fastapi import HTTPException


class ParseErrorCode:
    EMPTY_PAYLOAD = "empty_payload"
    PARSER_RUNTIME = "parser_runtime"
    PARSE_FAILED = "parse_failed"
    INTERNAL = "internal_error"
    IMAGE_PAYLOAD_BUILD = "image_payload_build_failed"


def raise_parse_http(
    *,
    status_code: int,
    code: str,
    message: str,
    from_exc: BaseException | None = None,
) -> None:
    exc = HTTPException(
        status_code=status_code,
        detail={"error": code, "message": message},
    )
    if from_exc is not None:
        raise exc from from_exc
    raise exc
