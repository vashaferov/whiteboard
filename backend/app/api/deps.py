"""Shared FastAPI dependencies."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.api.errors import api_error
from app.config import Settings
from app.services.accounts import AccountStore, User
from app.services.auth import SESSION_COOKIE, TokenError, TokenPayload, decode_token
from app.services.images import ImageStorage
from app.services.room_manager import RoomManager
from app.services.storage import SnapshotStore

bearer_scheme = HTTPBearer(auto_error=False)


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_image_storage(request: Request) -> ImageStorage:
    return request.app.state.images


def get_account_store(request: Request) -> AccountStore:
    return request.app.state.accounts


def get_room_manager(request: Request) -> RoomManager:
    return request.app.state.manager


def get_snapshot_store(request: Request) -> SnapshotStore:
    return request.app.state.store


@dataclass(frozen=True, slots=True)
class AuthSession:
    user: User
    session_id: str


async def get_auth_session(
    request: Request,
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> AuthSession:
    session_id = request.cookies.get(SESSION_COOKIE)
    if not session_id:
        raise api_error(401, "unauthenticated", "Требуется авторизация")
    user = await accounts.get_session_user(session_id)
    if user is None:
        raise api_error(401, "unauthenticated", "Сессия истекла — войдите снова")
    if user.status != "active":
        raise api_error(401, "inactive", "Учётная запись недоступна")
    return AuthSession(user=user, session_id=session_id)


async def get_auth_user(session: Annotated[AuthSession, Depends(get_auth_session)]) -> User:
    return session.user


async def require_admin(user: Annotated[User, Depends(get_auth_user)]) -> User:
    if user.role != "admin":
        raise api_error(403, "forbidden", "Требуется администратор")
    return user


async def require_same_origin(request: Request) -> None:
    """Reject cross-site state-changing requests (CSRF guard)."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    origin = request.headers.get("origin") or request.headers.get("referer")
    if not origin:
        return
    if urlsplit(origin).netloc != request.headers.get("host", ""):
        raise api_error(403, "bad_origin", "Запрос с чужого источника")


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> TokenPayload:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется авторизация",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return decode_token(settings, credentials.credentials)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
