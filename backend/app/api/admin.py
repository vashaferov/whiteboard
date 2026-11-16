"""Administrator endpoints for user accounts."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.api.deps import (
    get_account_store,
    get_app_settings,
    get_room_manager,
    require_admin,
    require_same_origin,
)
from app.api.errors import api_error
from app.config import Settings
from app.models.schemas import (
    AdminPasswordReset,
    AdminUser,
    AdminUserPatch,
)
from app.services.accounts import AccountStore, User
from app.services.auth import hash_password
from app.services.room_manager import RoomManager

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(require_same_origin), Depends(require_admin)],
)


def admin_user(user: User) -> AdminUser:
    return AdminUser(
        id=user.id,
        login=user.login,
        name=user.name,
        role=user.role,
        status=user.status,
        createdAt=user.created_at,
    )


async def load_user(accounts: AccountStore, user_id: str) -> User:
    user = await accounts.get_user(user_id)
    if user is None:
        raise api_error(404, "not_found", "Пользователь не найден")
    return user


async def kick_everywhere(
    accounts: AccountStore, manager: RoomManager, user_id: str, reason: str
) -> None:
    for room_id in await accounts.list_room_ids():
        await manager.kick(room_id, user_id, reason=reason)


@router.get("/users", response_model=list[AdminUser])
async def list_users(
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    role: Annotated[str | None, Query()] = None,
    q: Annotated[str, Query(max_length=80)] = "",
) -> list[AdminUser]:
    users = await accounts.list_users(status=status_filter, role=role, query=q or None)
    users.sort(key=lambda user: (user.status != "pending", user.created_at))
    return [admin_user(user) for user in users]


@router.patch("/users/{user_id}", response_model=AdminUser)
async def update_user(
    user_id: str,
    payload: AdminUserPatch,
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    manager: Annotated[RoomManager, Depends(get_room_manager)],
) -> AdminUser:
    target = await load_user(accounts, user_id)
    if target.role == "admin":
        raise api_error(400, "last_admin", "Администратора нельзя изменить")

    updated = await accounts.update_user(user_id, status=payload.status, role=payload.role)
    if updated is None:
        raise api_error(404, "not_found", "Пользователь не найден")

    role_changed = payload.role is not None and payload.role != target.role
    reason: str | None = None
    if payload.status == "blocked":
        reason = "Учётная запись заблокирована"
    elif payload.status == "rejected":
        reason = "Доступ закрыт"
    elif role_changed:
        reason = "Ваша роль изменилась"

    if reason is not None:
        await accounts.delete_user_sessions(user_id)
        await kick_everywhere(accounts, manager, user_id, reason)
    return admin_user(updated)


@router.post("/users/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(
    user_id: str,
    payload: AdminPasswordReset,
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    manager: Annotated[RoomManager, Depends(get_room_manager)],
) -> None:
    await load_user(accounts, user_id)
    await accounts.set_password(user_id, hash_password(payload.password, settings.password_rounds))
    await accounts.delete_user_sessions(user_id)
    await kick_everywhere(accounts, manager, user_id, "Пароль изменён — войдите снова")
