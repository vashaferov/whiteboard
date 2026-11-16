"""Room CRUD, access grants and the student directory."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status

from app.api.deps import (
    get_account_store,
    get_auth_user,
    get_room_manager,
    get_snapshot_store,
    require_admin,
    require_same_origin,
)
from app.api.errors import api_error
from app.models.schemas import (
    ROOM_ID_PATTERN,
    RoomAccessUpdate,
    RoomCreate,
    RoomInfo,
    RoomRename,
    StudentInfo,
)
from app.services.access import can_access_room
from app.services.accounts import AccountStore, Room, User
from app.services.auth import is_staff
from app.services.room_manager import RoomManager
from app.services.storage import SnapshotStore

router = APIRouter(
    prefix="/api",
    tags=["rooms"],
    dependencies=[Depends(require_same_origin)],
)

RoomPath = Annotated[str, Path(pattern=ROOM_ID_PATTERN)]

REVOKED_REASON = "Учитель отменил доступ к комнате"


def room_info(room: Room) -> RoomInfo:
    return RoomInfo(
        id=room.id,
        name=room.name,
        owner={"id": room.owner_id, "name": room.owner_name},
    )


def student_info(user: User) -> StudentInfo:
    return StudentInfo(id=user.id, name=user.name, login=user.login)


async def load_room(accounts: AccountStore, room_id: str) -> Room:
    room = await accounts.get_room(room_id)
    if room is None:
        raise api_error(404, "not_found", "Комната не найдена")
    return room


def ensure_manager(room: Room, user: User) -> None:
    if user.role == "admin":
        return
    if user.role == "teacher" and room.owner_id == user.id:
        return
    raise api_error(403, "forbidden", "Управлять комнатой может её владелец")


@router.get("/rooms", response_model=list[RoomInfo])
async def list_rooms(
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> list[RoomInfo]:
    if user.role == "student":
        rooms = await accounts.list_rooms_for_student(user.id)
    else:
        rooms = await accounts.list_owned_rooms(user.id)
    return [room_info(room) for room in rooms]


@router.get(
    "/rooms/all",
    response_model=list[RoomInfo],
    dependencies=[Depends(require_admin)],
)
async def list_all_rooms(
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> list[RoomInfo]:
    return [room_info(room) for room in await accounts.list_all_rooms()]


@router.post("/rooms", response_model=RoomInfo, status_code=status.HTTP_201_CREATED)
async def create_room(
    payload: RoomCreate,
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> RoomInfo:
    if not is_staff(user.role):
        raise api_error(403, "forbidden", "Создавать комнаты может только учитель")
    room = await accounts.create_room(owner_id=user.id, name=payload.name)
    return room_info(room)


@router.get("/rooms/{room_id}", response_model=RoomInfo)
async def get_room(
    room_id: RoomPath,
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> RoomInfo:
    room = await load_room(accounts, room_id)
    granted = await accounts.has_room_access(room_id, user.id)
    if not can_access_room(user, room, granted=granted):
        raise api_error(403, "forbidden", "Нет доступа к комнате")
    return room_info(room)


@router.patch("/rooms/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
async def rename_room(
    room_id: RoomPath,
    payload: RoomRename,
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> None:
    room = await load_room(accounts, room_id)
    ensure_manager(room, user)
    await accounts.rename_room(room_id, payload.name)


@router.delete("/rooms/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_room(
    room_id: RoomPath,
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    manager: Annotated[RoomManager, Depends(get_room_manager)],
    store: Annotated[SnapshotStore, Depends(get_snapshot_store)],
) -> None:
    room = await load_room(accounts, room_id)
    ensure_manager(room, user)
    await manager.close_room(room_id, notify_remote=True)
    await accounts.delete_room(room_id)
    await store.delete(room_id)


@router.get("/rooms/{room_id}/access", response_model=list[StudentInfo])
async def list_access(
    room_id: RoomPath,
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
) -> list[StudentInfo]:
    room = await load_room(accounts, room_id)
    ensure_manager(room, user)
    return [student_info(item) for item in await accounts.list_room_access(room_id)]


@router.put("/rooms/{room_id}/access", response_model=list[StudentInfo])
async def update_access(
    room_id: RoomPath,
    payload: RoomAccessUpdate,
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    manager: Annotated[RoomManager, Depends(get_room_manager)],
) -> list[StudentInfo]:
    room = await load_room(accounts, room_id)
    ensure_manager(room, user)

    for user_id in dict.fromkeys(payload.userIds):
        target = await accounts.get_user(user_id)
        if target is None or target.status != "active" or target.role != "student":
            raise api_error(400, "invalid_user", "Доступ выдаётся только активным ученикам")

    current, _added, removed = await accounts.set_room_access(
        room_id, list(dict.fromkeys(payload.userIds)), granted_by=user.id
    )
    for user_id in removed:
        await manager.kick(room_id, user_id, reason=REVOKED_REASON)
    return [student_info(item) for item in current]


@router.get("/users", response_model=list[StudentInfo])
async def list_students(
    user: Annotated[User, Depends(get_auth_user)],
    accounts: Annotated[AccountStore, Depends(get_account_store)],
    q: Annotated[str, Query(max_length=80)] = "",
) -> list[StudentInfo]:
    if not is_staff(user.role):
        raise api_error(403, "forbidden", "Каталог учеников доступен учителю")
    return [student_info(item) for item in await accounts.list_active_students(q or None)]
