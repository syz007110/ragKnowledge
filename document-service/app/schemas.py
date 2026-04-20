from __future__ import annotations

from pydantic import BaseModel, Field


class ParseResponseModel(BaseModel):
    """POST /internal/v1/parse — see docs/unified-parse-schema.example.json."""

    parseDocument: dict = Field(default_factory=dict)
    embeddedImagePayloadsEncoding: str = "base64"
    embeddedImagePayloads: dict[str, dict] = Field(default_factory=dict)


class ParseResultModel(BaseModel):
    """Parse response: legacy shapes plus optional schemaVersion 2 parseDocument."""

    rawText: str = ""
    docx: dict | None = None
    xlsx: dict | None = None
    pdf: dict | None = None
    parseDocument: dict | None = None
    chunks: list[dict] = Field(default_factory=list)
    parserKind: str = ""
    fileExt: str = ""


class NormalizeRequest(BaseModel):
    text: str = ""
    fileExt: str = ""


class NormalizeResponse(BaseModel):
    cleanedText: str = ""


class ChunkRequest(BaseModel):
    mode: str = Field(default="text", description="text|structured")
    text: str = ""
    blocks: list[dict] = Field(default_factory=list)
    maxChunkSize: int = 800


class ChunkResponse(BaseModel):
    chunks: list[dict] = Field(default_factory=list)


class CleanParseRequest(BaseModel):
    """POST /internal/v1/clean — input is ParseDocument (see docs/unified-parse-schema.md)."""

    parseDocument: dict = Field(default_factory=dict)


class CleanedDocumentResponse(BaseModel):
    """CleanedDocument (see docs/cleaned-parse-schema.example.json)."""

    schemaVersion: str = "1.0"
    upstream: dict = Field(default_factory=dict)
    meta: dict = Field(default_factory=dict)
    assets: list = Field(default_factory=list)
    pages: list = Field(default_factory=list)
    chunkView: dict = Field(default_factory=dict)


class PlainFromPagesRequest(BaseModel):
    """POST /internal/v1/plain-from-pages — flatten text from ParseDocument/CleanedDocument pages."""

    pages: list = Field(default_factory=list)


class PlainFromPagesResponse(BaseModel):
    plainText: str = ""


