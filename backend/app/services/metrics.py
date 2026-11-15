"""Prometheus metrics for HTTP, WebSocket and uploads."""

from __future__ import annotations

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

REGISTRY = CollectorRegistry()

HTTP_REQUESTS = Counter(
    "whiteboard_http_requests_total",
    "HTTP requests by method, route and status.",
    ["method", "path", "status"],
    registry=REGISTRY,
)
HTTP_DURATION = Histogram(
    "whiteboard_http_request_duration_seconds",
    "HTTP request duration in seconds.",
    ["method", "path"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
    registry=REGISTRY,
)
WS_MESSAGES = Counter(
    "whiteboard_ws_messages_total",
    "Accepted WebSocket messages by type.",
    ["type"],
    registry=REGISTRY,
)
WS_ERRORS = Counter(
    "whiteboard_ws_errors_total",
    "WebSocket errors sent to clients by code.",
    ["code"],
    registry=REGISTRY,
)
WS_CONNECTIONS = Gauge(
    "whiteboard_ws_connections",
    "Currently open WebSocket connections.",
    registry=REGISTRY,
)
ROOMS = Gauge(
    "whiteboard_rooms",
    "Active rooms on this instance.",
    registry=REGISTRY,
)
USERS = Gauge(
    "whiteboard_users",
    "Connected users on this instance.",
    registry=REGISTRY,
)
UPLOAD_BYTES = Counter(
    "whiteboard_upload_bytes_total",
    "Total bytes accepted by the image upload endpoint.",
    registry=REGISTRY,
)


def render_metrics(manager) -> tuple[bytes, str]:
    """Refresh room gauges and return the Prometheus text payload."""

    ROOMS.set(manager.room_count)
    USERS.set(manager.user_count)
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST
