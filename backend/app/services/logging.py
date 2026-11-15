"""Application logging: plain text locally, JSON in production."""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from app.config import Settings

request_id_var: ContextVar[str] = ContextVar("request_id", default="")

_EXTRA_FIELDS = (
    "method",
    "path",
    "status",
    "duration_ms",
    "client",
    "rooms",
    "users",
    "event",
)


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        for field in _EXTRA_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


class AccessLogFilter(logging.Filter):
    """Drop uvicorn's unstructured access lines; the middleware logs them."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name != "uvicorn.access"


def configure_logging(settings: Settings) -> None:
    """Configure root and uvicorn loggers once per process."""

    if getattr(configure_logging, "_configured", False):
        return
    configure_logging._configured = True  # type: ignore[attr-defined]

    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RequestIdFilter())
    if settings.log_json:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s")
        )

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers = [handler]
        logger.propagate = False
        logger.setLevel(level)
    logging.getLogger("uvicorn.access").disabled = True


def init_sentry(settings: Settings) -> None:
    """Enable Sentry only when a DSN is configured."""

    if not settings.sentry_dsn:
        return
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        send_default_pii=False,
    )
    logging.getLogger(__name__).info("Sentry is enabled")
