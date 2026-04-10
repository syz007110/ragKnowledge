"""HTTP-level tests for /internal/v1/parse (in-process via TestClient; no server required)."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from unittest.mock import patch

from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json().get("ok") is True


def test_parse_txt_returns_contract_shape(client: TestClient) -> None:
    r = client.post(
        "/internal/v1/parse",
        files={"file": ("sample.txt", b"line1\n\nline2", "text/plain")},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(data.keys()) == {
        "parseDocument",
        "embeddedImagePayloadsEncoding",
        "embeddedImagePayloads",
    }
    assert data["embeddedImagePayloadsEncoding"] == "base64"
    assert data["embeddedImagePayloads"] == {}
    pd = data["parseDocument"]
    assert isinstance(pd, dict)
    assert pd.get("schemaVersion") == "2.0"
    assert pd.get("fileExt") == "txt"
    assert isinstance(pd.get("parserKind"), str) and pd["parserKind"]
    pages = pd.get("pages")
    assert isinstance(pages, list) and pages


def test_parse_rejects_wrong_internal_key(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KB_DOCUMENT_SERVICE_API_KEY", "expected-secret")
    try:
        r = client.post(
            "/internal/v1/parse",
            files={"file": ("a.txt", b"x", "text/plain")},
            headers={"X-Internal-Api-Key": "wrong"},
        )
        assert r.status_code == 401
        r_ok = client.post(
            "/internal/v1/parse",
            files={"file": ("a.txt", b"x", "text/plain")},
            headers={"X-Internal-Api-Key": "expected-secret"},
        )
        assert r_ok.status_code == 200
    finally:
        monkeypatch.delenv("KB_DOCUMENT_SERVICE_API_KEY", raising=False)


def test_pipeline_ingest_still_returns_full_parse_result_model(client: TestClient) -> None:
    r = client.post(
        "/internal/v1/pipeline/ingest",
        files={"file": ("sample.txt", b"alpha\n\nbeta", "text/plain")},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "rawText" in data and "parseDocument" in data and "chunks" in data
    assert isinstance(data.get("chunks"), list) and len(data["chunks"]) >= 1


def test_parse_empty_txt_returns_200(client: TestClient) -> None:
    r = client.post(
        "/internal/v1/parse",
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["embeddedImagePayloadsEncoding"] == "base64"
    assert data["embeddedImagePayloads"] == {}
    assert data["parseDocument"].get("schemaVersion") == "2.0"


def test_parse_empty_binary_returns_400(client: TestClient) -> None:
    for name in ("empty.docx", "empty.xlsx", "empty.pdf"):
        r = client.post(
            "/internal/v1/parse",
            files={"file": (name, b"", "application/octet-stream")},
        )
        assert r.status_code == 400, r.text
        body = r.json()
        assert body.get("detail", {}).get("error") == "empty_payload"


def test_parse_runtime_error_returns_structured_422(client: TestClient) -> None:
    with patch("app.main.registry") as reg:
        parser = reg.get_parser.return_value
        parser.parse.side_effect = RuntimeError("parser.docxUnavailable")
        parser.name = "docx_mock"
        r = client.post(
            "/internal/v1/parse",
            files={"file": ("x.docx", b"dummy", "application/octet-stream")},
        )
    assert r.status_code == 422
    body = r.json()
    detail = body.get("detail") or {}
    assert detail.get("error") == "parser_runtime"
    assert "parser.docxUnavailable" in str(detail.get("message", ""))


def test_parse_value_error_returns_structured_422(client: TestClient) -> None:
    with patch("app.main.registry") as reg:
        parser = reg.get_parser.return_value
        parser.parse.side_effect = ValueError("corrupt document")
        parser.name = "pdf_mock"
        r = client.post(
            "/internal/v1/parse",
            files={"file": ("x.pdf", b"%PDF-1.4 broken", "application/pdf")},
        )
    assert r.status_code == 422
    detail = (r.json() or {}).get("detail") or {}
    assert detail.get("error") == "parse_failed"
    assert "corrupt" in str(detail.get("message", "")).lower()


def test_parse_md_data_uri_image_embedded_payloads(client: TestClient) -> None:
    tiny_png_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    md_body = f"![](data:image/png;base64,{tiny_png_b64})\n"
    r = client.post(
        "/internal/v1/parse",
        files={"file": ("x.md", md_body.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    payloads = data.get("embeddedImagePayloads") or {}
    assert len(payloads) == 1
    _pid, pl = next(iter(payloads.items()))
    assert pl.get("base64")
    assert int(pl.get("byteLength") or 0) > 0
    assert pl.get("sha256")
    pd = data["parseDocument"]
    asset_ids = {str(a.get("id")) for a in (pd.get("assets") or []) if isinstance(a, dict)}
    assert set(payloads.keys()) <= asset_ids


def test_clean_returns_cleaned_document(client: TestClient) -> None:
    r = client.post(
        "/internal/v1/parse",
        files={"file": ("sample.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 200, r.text
    pd = r.json()["parseDocument"]
    r2 = client.post("/internal/v1/clean", json={"parseDocument": pd})
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body.get("schemaVersion") == "1.0"
    assert isinstance(body.get("upstream"), dict)
    assert isinstance(body.get("chunkView"), dict)
    assert all("headingPath" in b for b in (body["chunkView"].get("blocks") or []) if isinstance(b, dict))


def test_clean_rejects_empty_parse_document(client: TestClient) -> None:
    r = client.post("/internal/v1/clean", json={"parseDocument": {}})
    assert r.status_code == 400
