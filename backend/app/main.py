"""FastAPI application entry point."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import accounts, admin, rooms, upload, ws
from app.config import Settings, get_settings
from app.services import metrics
from app.services.accounts import AccountStore
from app.services.auth import WindowLimiter, hash_password
from app.services.images import build_image_storage
from app.services.logging import configure_logging, init_sentry, request_id_var
from app.services.room_manager import RoomManager
from app.services.storage import SnapshotStore

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)
    init_sentry(settings)

    # StaticFiles requires existing directories at mount time.
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = SnapshotStore(settings.data_dir / "whiteboard.db")
        accounts = AccountStore(settings.data_dir / "whiteboard.db")
        images = build_image_storage(settings)
        await images.startup()
        manager = RoomManager(settings, store, images)
        await manager.startup()
        if accounts.legacy_wiped and settings.redis_enabled:
            await manager.purge_room_keys()
        created = await accounts.ensure_admin(
            login=settings.admin_login,
            name=settings.admin_name,
            password_hash=hash_password(settings.admin_password, settings.password_rounds),
        )
        if created is not None:
            logger.info("Bootstrap admin %s created", created.login)
        if settings.admin_password == "admin-change-me":
            logger.warning("Bootstrap admin password is the default; change it in the UI")
        await accounts.prune_sessions()
        app.state.settings = settings
        app.state.store = store
        app.state.accounts = accounts
        app.state.images = images
        app.state.manager = manager
        app.state.login_limiter = WindowLimiter(10, 60)
        app.state.register_limiter = WindowLimiter(5, 60)
        logger.info(
            "Whiteboard started (board %sx%s, data=%s, redis=%s, s3=%s)",
            settings.board_width,
            settings.board_height,
            settings.data_dir,
            settings.redis_enabled,
            settings.s3_enabled,
        )
        try:
            yield
        finally:
            await manager.shutdown()
            await accounts.close()
            await store.close()
            await images.close()
            logger.info("Whiteboard stopped")

    app = FastAPI(title=settings.app_name, lifespan=lifespan)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        except Exception:
            logger.exception("Unhandled error: %s %s", request.method, request.url.path)
            raise
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            route = request.scope.get("route")
            path = getattr(route, "path", request.url.path)
            metrics.HTTP_REQUESTS.labels(request.method, path, str(status_code)).inc()
            metrics.HTTP_DURATION.labels(request.method, path).observe(duration_ms / 1000)
            logger.info(
                "%s %s %s",
                request.method,
                request.url.path,
                status_code,
                extra={
                    "method": request.method,
                    "path": path,
                    "status": status_code,
                    "duration_ms": duration_ms,
                },
            )
            request_id_var.reset(token)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(accounts.router)
    app.include_router(admin.router)
    app.include_router(rooms.router)
    app.include_router(upload.router)
    app.include_router(ws.router)

    @app.get("/health", tags=["system"])
    async def health() -> dict[str, object]:
        manager: RoomManager = app.state.manager
        return {
            "status": "ok",
            "rooms": manager.room_count,
            "users": manager.user_count,
        }

    @app.get("/health/ready", tags=["system"])
    async def readiness() -> JSONResponse:
        manager: RoomManager = app.state.manager
        store: SnapshotStore = app.state.store
        images = app.state.images
        checks = {
            "db": await store.ping(),
            "storage": await images.check(),
            "redis": await manager.check_redis(),
        }
        ready = checks["db"] and checks["storage"] and checks["redis"] is not False
        return JSONResponse(
            status_code=200 if ready else 503,
            content={"status": "ok" if ready else "degraded", "checks": checks},
        )

    if settings.metrics_enabled:

        @app.get("/metrics", tags=["system"])
        async def prometheus() -> Response:
            payload, content_type = metrics.render_metrics(app.state.manager)
            return Response(content=payload, media_type=content_type)

    app.mount("/uploads", StaticFiles(directory=str(settings.uploads_dir)), name="uploads")

    if settings.frontend_dir.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=str(settings.frontend_dir), html=True),
            name="frontend",
        )

    return app


app = create_app()
