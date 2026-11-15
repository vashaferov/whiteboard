"""Observability: metrics, readiness and structured logs."""

from __future__ import annotations

import json
import logging

from app.config import Settings
from app.services.logging import JsonFormatter, request_id_var
from fastapi.testclient import TestClient


def test_health_ready_checks(client: TestClient) -> None:
    response = client.get("/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["checks"] == {"db": True, "storage": True, "redis": None}


class BrokenStorage:
    async def check(self) -> bool:
        return False


def test_health_ready_degrades(client: TestClient) -> None:
    client.app.state.images = BrokenStorage()
    response = client.get("/health/ready")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"
    assert response.json()["checks"]["storage"] is False


def test_metrics_endpoint(client: TestClient) -> None:
    client.get("/health")
    response = client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    body = response.text
    assert "whiteboard_http_requests_total" in body
    assert "whiteboard_rooms" in body
    assert "whiteboard_ws_connections" in body


def test_request_id_is_echoed_and_generated(client: TestClient) -> None:
    given = client.get("/health", headers={"X-Request-ID": "req-123"})
    assert given.headers["X-Request-ID"] == "req-123"

    generated = client.get("/health")
    assert len(generated.headers["X-Request-ID"]) == 32


def test_json_formatter_includes_request_id() -> None:
    record = logging.LogRecord("app.test", logging.INFO, __file__, 1, "hello %s", ("world",), None)
    token = request_id_var.set("rid-42")
    try:
        payload = json.loads(JsonFormatter().format(record))
    finally:
        request_id_var.reset(token)

    assert payload["message"] == "hello world"
    assert payload["level"] == "INFO"
    assert payload["logger"] == "app.test"
    assert payload["request_id"] == "rid-42"


def test_sentry_disabled_without_dsn(settings: Settings) -> None:
    from app.services.logging import init_sentry

    init_sentry(settings.model_copy(update={"sentry_dsn": ""}))
