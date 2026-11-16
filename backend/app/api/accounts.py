"""Registration, cookie login, logout and the current user endpoint."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import JSONResponse

from app.api.deps import (
    AuthSession,
    get_account_store,
    get_app_settings,
    get_auth_session,
    require_same_origin,
)
from app.api.errors import api_error
from app.config import Settings
from app.models.schemas import (
    AuthResponse,
    BoardSize,
    Credentials,
    RegisterRequest,
    UserInfo,
    permissions_for,
)
from app.services.accounts import AccountStore, LoginTakenError, User
from app.services.auth import (
    SESSION_COOKIE,
    WindowLimiter,
    hash_password,
    verify_password,
)

router = APIRouter(
    prefix="/api",
    tags=["auth"],
    dependencies=[Depends(require_same_origin)],
)

STATUS_MESSAGES = {
    "pending": "Заявка на рассмотрении. Администратор должен подтвердить учётную запись.",
    "rejected": "Заявка отклонена администратором.",
    "blocked": "Учётная запись заблокирована.",
}


def client_ip(request: Request) -> str:
    return request.client.host if request.client is not None else "unknown"


def user_info(user: User) -> UserInfo:
    return UserInfo(
        id=user.id,
        login=user.login,
        name=user.name,
        role=user.role,
        color=user.color,
    )


def auth_response(user: User, settings: Settings) -> AuthResponse:
    return AuthResponse(
        user=user_info(user),
        permissions=permissions_for(user.role),
        board=BoardSize(width=settings.board_width, height=settings.board_height),
    )


def set_session_cookie(response: Response, settings: Settings, session_id: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        max_age=int(settings.session_ttl_hours * 3600),
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    payload: RegisterRequest,
    request: Request,
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> dict[str, str]:
    limiter: WindowLimiter = request.app.state.register_limiter
    if not limiter.hit(f"register:{client_ip(request)}"):
        raise api_error(429, "rate_limited", "Слишком много попыток регистрации")

    try:
        await accounts.create_user(
            login=payload.login,
            name=payload.name,
            password_hash=hash_password(payload.password, settings.password_rounds),
        )
    except LoginTakenError as exc:
        raise api_error(409, "login_taken", "Этот логин уже занят") from exc
    return {"status": "pending"}


@router.post("/login", response_model=None)
async def login(
    payload: Credentials,
    request: Request,
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> JSONResponse:
    limiter: WindowLimiter = request.app.state.login_limiter
    bucket = f"login:{client_ip(request)}"
    if not limiter.hit(bucket):
        raise api_error(429, "rate_limited", "Слишком много попыток входа")

    found = await accounts.get_user_with_hash(payload.login)
    if found is None or not verify_password(payload.password, found[1]):
        raise api_error(401, "invalid_credentials", "Неверный логин или пароль")
    user, _ = found
    if user.status != "active":
        raise api_error(403, user.status, STATUS_MESSAGES.get(user.status, "Доступ закрыт"))
    limiter.reset(bucket)

    session_id = await accounts.create_session(user.id, int(settings.session_ttl_hours * 3600))
    response = JSONResponse(auth_response(user, settings).model_dump())
    set_session_cookie(response, settings, session_id)
    return response


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> Response:
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id:
        await accounts.delete_session(session_id)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@router.get("/me", response_model=AuthResponse)
async def me(
    session: Annotated[AuthSession, Depends(get_auth_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> AuthResponse:
    return auth_response(session.user, settings)
