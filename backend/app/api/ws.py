"""WebSocket endpoint: room presence, drawing sync, roles and rate limits."""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.config import Settings
from app.models.schemas import (
    OBJECT_ID_PATTERN,
    ROOM_ID_PATTERN,
    Clear,
    ClientMessage,
    Cursor,
    ImageAdd,
    Kick,
    ObjectDelete,
    ObjectTransform,
    ObjectUpdate,
    ShapeAdd,
    StrokeEnd,
    StrokePoint,
    StrokeStart,
    TextAdd,
    TextUpdate,
    WorkspaceCreate,
    WorkspaceDelete,
    WorkspaceMoveAck,
    WorkspacePull,
    WorkspaceRename,
    WorkspaceReorder,
    WorkspaceSwitch,
    client_message_adapter,
    permissions_for,
)
from app.services import metrics
from app.services.auth import TokenError, decode_token
from app.services.room_manager import ConnectedUser, RateLimiter, Room, RoomManager

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_POINTS_PER_STROKE = 20000
MAX_ACTIVE_STROKES = 8


def _error(code: str, message: str) -> dict[str, str]:
    metrics.WS_ERRORS.labels(code=code).inc()
    return {"type": "error", "code": code, "message": message}


def _limiter(settings: Settings) -> RateLimiter:
    return RateLimiter(
        {
            "points": settings.rate_limit_points_per_sec,
            "cursor": settings.rate_limit_cursors_per_sec,
            "default": settings.rate_limit_messages_per_sec,
        }
    )


def _new_object(
    user: ConnectedUser, object_id: str, object_type: str, **fields: Any
) -> dict[str, Any]:
    return {
        "id": object_id,
        "type": object_type,
        "author": user.id,
        "workspaceId": user.workspace_id,
        **fields,
    }


def _can_edit_object(user: ConnectedUser, obj: dict[str, Any]) -> bool:
    return user.role == "teacher" or obj.get("author") == user.id


async def _check_workspace(manager: RoomManager, user: ConnectedUser, message: Any) -> bool:
    """Reject messages whose explicit ``workspaceId`` no longer matches the user's page."""
    if message.workspaceId is not None and message.workspaceId != user.workspace_id:
        await manager.send_to(user, _error("stale_workspace", "Страница устарела"))
        return False
    return True


async def _check_object_workspace(
    manager: RoomManager, room: Room, user: ConnectedUser, message: Any
) -> dict[str, Any] | None:
    """Return the target object if it belongs to the user's page, else reject and None."""
    if not await _check_workspace(manager, user, message):
        return None
    obj = room.get_object(message.objectId)
    if obj is None:
        return None
    if obj.get("workspaceId") != user.workspace_id:
        await manager.send_to(user, _error("stale_workspace", "Страница устарела"))
        return None
    return obj


@router.websocket("/ws/{room_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    token: str = Query(default=""),
    workspace: str = Query(default=""),
) -> None:
    settings: Settings = websocket.app.state.settings
    manager: RoomManager = websocket.app.state.manager

    if not re.fullmatch(ROOM_ID_PATTERN, room_id):
        await websocket.close(code=4400, reason="invalid_room")
        return

    try:
        payload = decode_token(settings, token)
    except TokenError:
        await websocket.close(code=4401, reason="unauthorized")
        return

    if payload.room_id != room_id:
        await websocket.close(code=4403, reason="room_mismatch")
        return

    await websocket.accept()
    metrics.WS_CONNECTIONS.inc()

    user = ConnectedUser(
        id=payload.user_id,
        name=payload.name,
        role=payload.role,
        color=payload.color,
        websocket=websocket,
        limiter=_limiter(settings),
    )
    room = await manager.join(room_id, user)
    if workspace and room.get_workspace(workspace) is not None:
        user.workspace_id = workspace
    else:
        user.workspace_id = room.workspace_ids()[0]
    users = await manager.list_users(room)

    try:
        await websocket.send_json(
            {
                "type": "init",
                "clientId": user.id,
                "roomId": room.id,
                "role": user.role,
                "users": users,
                "objects": manager.objects_for(room, user.workspace_id),
                "userCount": len(users),
                "board": {"width": settings.board_width, "height": settings.board_height},
                "permissions": permissions_for(user.role).model_dump(),
                "workspaces": room.workspace_list(),
                "workspaceId": user.workspace_id,
            }
        )
        await manager.broadcast(
            room,
            {"type": "user_joined", "user": user.public()},
            exclude=user.id,
        )
        await _receive_loop(websocket, manager, room, user, settings)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - keep the server alive on malformed clients
        logger.exception("WebSocket failure in room %s for user %s", room_id, user.id)
    finally:
        await manager.leave(room_id, user.id)
        metrics.WS_CONNECTIONS.dec()


async def _receive_loop(
    websocket: WebSocket,
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    settings: Settings,
) -> None:
    while True:
        raw = await websocket.receive_text()
        if len(raw) > settings.max_message_bytes:
            await manager.send_to(user, _error("message_too_large", "Сообщение слишком большое"))
            continue
        try:
            message = client_message_adapter.validate_json(raw)
        except ValidationError:
            await manager.send_to(user, _error("invalid_message", "Некорректное сообщение"))
            continue
        metrics.WS_MESSAGES.labels(type=message.type).inc()
        await _handle_message(manager, room, user, message, settings)


async def _handle_message(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ClientMessage,
    settings: Settings,
) -> None:
    kind = message.type
    category = "points" if kind == "stroke_point" else "cursor" if kind == "cursor" else "default"
    if not user.limiter.allow(category):
        return

    if isinstance(message, StrokeStart):
        await _handle_stroke_start(manager, room, user, message)
    elif isinstance(message, StrokePoint):
        await _handle_stroke_point(manager, room, user, message)
    elif isinstance(message, StrokeEnd):
        await _handle_stroke_end(manager, room, user, message)
    elif isinstance(message, ShapeAdd):
        await _handle_shape_add(manager, room, user, message)
    elif isinstance(message, TextAdd):
        await _handle_text_add(manager, room, user, message)
    elif isinstance(message, ImageAdd):
        await _handle_image_add(manager, room, user, message)
    elif isinstance(message, ObjectUpdate):
        await _handle_object_update(manager, room, user, message)
    elif isinstance(message, ObjectTransform):
        await _handle_object_transform(manager, room, user, message)
    elif isinstance(message, TextUpdate):
        await _handle_text_update(manager, room, user, message)
    elif isinstance(message, ObjectDelete):
        await _handle_object_delete(manager, room, user, message)
    elif isinstance(message, Cursor):
        await _handle_cursor(manager, room, user, message)
    elif isinstance(message, Clear):
        await _handle_clear(manager, room, user, message)
    elif isinstance(message, Kick):
        await _handle_kick(manager, room, user, message)
    elif isinstance(message, WorkspaceSwitch):
        await _handle_workspace_switch(manager, room, user, message)
    elif isinstance(message, WorkspaceCreate):
        await _handle_workspace_create(manager, room, user, message, settings)
    elif isinstance(message, WorkspaceRename):
        await _handle_workspace_rename(manager, room, user, message)
    elif isinstance(message, WorkspaceDelete):
        await _handle_workspace_delete(manager, room, user, message)
    elif isinstance(message, WorkspaceReorder):
        await _handle_workspace_reorder(manager, room, user, message)
    elif isinstance(message, WorkspacePull):
        await _handle_workspace_pull(manager, room, user, message)
    elif isinstance(message, WorkspaceMoveAck):
        await _handle_workspace_move_ack(manager, room, user, message)


async def _handle_stroke_start(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: StrokeStart,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    if len(user.strokes) >= MAX_ACTIVE_STROKES:
        await manager.send_to(
            user, _error("too_many_strokes", "Слишком много штрихов одновременно")
        )
        return
    if room.get_object(message.objectId) is not None or message.objectId in user.strokes:
        await manager.send_to(user, _error("duplicate_object", "Объект уже существует"))
        return

    obj = _new_object(
        user,
        message.objectId,
        "stroke",
        tool=message.tool,
        color=message.color,
        width=message.width,
        points=[[message.point.x, message.point.y]],
    )
    user.strokes[message.objectId] = obj
    await manager.broadcast(
        room,
        {"type": "stroke_start", "id": user.id, "object": obj, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_stroke_point(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: StrokePoint,
) -> None:
    obj = user.strokes.get(message.objectId)
    if obj is None:
        return
    if not await _check_workspace(manager, user, message):
        return
    points: list[list[float]] = obj["points"]
    if len(points) >= MAX_POINTS_PER_STROKE:
        return
    point = [message.point.x, message.point.y]
    points.append(point)
    await manager.broadcast(
        room,
        {
            "type": "stroke_point",
            "id": user.id,
            "objectId": message.objectId,
            "point": point,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_stroke_end(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: StrokeEnd,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    obj = user.strokes.pop(message.objectId, None)
    if obj is None:
        return
    if not manager.has_capacity(room):
        await manager.send_to(user, _error("room_full", "Достигнут лимит объектов на доске"))
        return
    manager.add_object(room, obj, user.workspace_id)
    await manager.broadcast(
        room,
        {"type": "stroke_end", "id": user.id, "object": obj, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_shape_add(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ShapeAdd,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    if room.get_object(message.objectId) is not None:
        return
    if not manager.has_capacity(room):
        await manager.send_to(user, _error("room_full", "Достигнут лимит объектов на доске"))
        return
    obj = _new_object(
        user,
        message.objectId,
        "shape",
        shapeType=message.shapeType,
        x=message.x,
        y=message.y,
        width=message.width,
        height=message.height,
        color=message.color,
        strokeWidth=message.strokeWidth,
        fill=message.fill,
    )
    manager.add_object(room, obj, user.workspace_id)
    await manager.broadcast(
        room,
        {"type": "shape_add", "id": user.id, "object": obj, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_text_add(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: TextAdd,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    if room.get_object(message.objectId) is not None:
        return
    if not manager.has_capacity(room):
        await manager.send_to(user, _error("room_full", "Достигнут лимит объектов на доске"))
        return
    obj = _new_object(
        user,
        message.objectId,
        "text",
        content=message.content,
        x=message.x,
        y=message.y,
        color=message.color,
        fontSize=message.fontSize,
    )
    manager.add_object(room, obj, user.workspace_id)
    await manager.broadcast(
        room,
        {"type": "text_add", "id": user.id, "object": obj, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_image_add(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ImageAdd,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    if room.get_object(message.objectId) is not None:
        return
    if not await manager.images.exists(message.url):
        await manager.send_to(user, _error("unknown_image", "Изображение не найдено"))
        return
    if not manager.has_capacity(room):
        await manager.send_to(user, _error("room_full", "Достигнут лимит объектов на доске"))
        return
    obj = _new_object(
        user,
        message.objectId,
        "image",
        url=message.url,
        x=message.x,
        y=message.y,
        width=message.width,
        height=message.height,
    )
    manager.add_object(room, obj, user.workspace_id)
    await manager.broadcast(
        room,
        {"type": "image_add", "id": user.id, "object": obj, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_object_update(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ObjectUpdate,
) -> None:
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно перемещать только свои объекты"))
        return
    manager.update_object(room, message.objectId, message.x, message.y)
    await manager.broadcast(
        room,
        {
            "type": "object_update",
            "id": user.id,
            "objectId": message.objectId,
            "x": message.x,
            "y": message.y,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_object_transform(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ObjectTransform,
) -> None:
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно изменять только свои объекты"))
        return
    if obj.get("type") == "stroke":
        await manager.send_to(
            user, _error("not_transformable", "Штрихи нельзя масштабировать или поворачивать")
        )
        return

    fields: dict[str, Any] = {
        "x": message.x,
        "y": message.y,
        "rotation": message.rotation,
    }
    if obj.get("type") == "text":
        if message.fontSize is not None:
            fields["fontSize"] = message.fontSize
    else:
        if message.width is not None and message.width != 0:
            fields["width"] = message.width
        if message.height is not None and message.height != 0:
            fields["height"] = message.height

    updated = manager.update_object_fields(room, message.objectId, **fields)
    if updated is None:
        return
    await manager.broadcast(
        room,
        {
            "type": "object_transform",
            "id": user.id,
            "object": updated,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_text_update(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: TextUpdate,
) -> None:
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if obj.get("type") != "text":
        await manager.send_to(user, _error("not_text", "Объект не является текстом"))
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно изменять только свои объекты"))
        return
    content = message.content.strip()
    if not content:
        await manager.send_to(user, _error("invalid_message", "Текст не может быть пустым"))
        return
    updated = manager.update_object_fields(room, message.objectId, content=content)
    if updated is None:
        return
    await manager.broadcast(
        room,
        {
            "type": "text_update",
            "id": user.id,
            "object": updated,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_object_delete(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ObjectDelete,
) -> None:
    if user.role != "teacher":
        await manager.send_to(user, _error("forbidden", "Удалять объекты может только учитель"))
        return
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if manager.delete_object(room, message.objectId) is None:
        return
    await manager.broadcast(
        room,
        {
            "type": "object_delete",
            "id": user.id,
            "objectId": message.objectId,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_cursor(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: Cursor,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    await manager.broadcast(
        room,
        {
            "type": "cursor",
            "id": user.id,
            "name": user.name,
            "color": user.color,
            "x": message.x,
            "y": message.y,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_clear(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: Clear,
) -> None:
    if user.role != "teacher":
        await manager.send_to(user, _error("forbidden", "Очистить доску может только учитель"))
        return
    if not await _check_workspace(manager, user, message):
        return
    manager.clear_room(room, user.workspace_id)
    await manager.broadcast(
        room,
        {"type": "clear", "id": user.id, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_kick(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: Kick,
) -> None:
    if user.role != "teacher":
        await manager.send_to(
            user, _error("forbidden", "Отключать участников может только учитель")
        )
        return
    if not re.fullmatch(OBJECT_ID_PATTERN, message.clientId) or message.clientId == user.id:
        return
    if not await manager.kick(room.id, message.clientId):
        await manager.send_to(user, _error("user_not_found", "Участник не найден"))


async def _handle_workspace_switch(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceSwitch,
) -> None:
    if not await manager.switch_workspace(room, user, message.workspaceId):
        await manager.send_to(user, _error("workspace_not_found", "Страница не найдена"))


async def _handle_workspace_create(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceCreate,
    settings: Settings,
) -> None:
    if user.role != "teacher":
        await manager.send_to(user, _error("forbidden", "Создавать страницы может только учитель"))
        return
    if len(room.workspaces) >= settings.max_workspaces_per_room:
        await manager.send_to(user, _error("workspace_limit", "Достигнут лимит страниц"))
        return
    workspace = manager.create_workspace(room, message.name)
    await manager.broadcast(room, {"type": "workspace_created", "workspace": workspace})
    await manager.switch_workspace(room, user, workspace["id"], reason="create")


async def _handle_workspace_rename(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceRename,
) -> None:
    if user.role != "teacher":
        await manager.send_to(
            user, _error("forbidden", "Переименовывать страницы может только учитель")
        )
        return
    name = message.name.strip()
    if not name:
        await manager.send_to(user, _error("invalid_message", "Название не может быть пустым"))
        return
    if manager.rename_workspace(room, message.workspaceId, name) is None:
        await manager.send_to(user, _error("workspace_not_found", "Страница не найдена"))
        return
    await manager.broadcast(
        room,
        {"type": "workspace_renamed", "workspaceId": message.workspaceId, "name": name},
    )


async def _handle_workspace_delete(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceDelete,
) -> None:
    if user.role != "teacher":
        await manager.send_to(user, _error("forbidden", "Удалять страницы может только учитель"))
        return
    deleted, fallback = manager.delete_workspace(room, message.workspaceId)
    if deleted is None:
        await manager.send_to(user, _error("last_workspace", "Нельзя удалить последнюю страницу"))
        return
    await manager.broadcast(
        room,
        {"type": "workspace_deleted", "workspaceId": deleted["id"], "fallbackId": fallback},
    )
    await manager.move_users_from_deleted(room, deleted["id"], fallback)


async def _handle_workspace_reorder(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceReorder,
) -> None:
    if user.role != "teacher":
        await manager.send_to(
            user, _error("forbidden", "Менять порядок страниц может только учитель")
        )
        return
    if not manager.reorder_workspaces(room, message.workspaceIds):
        await manager.send_to(user, _error("invalid_message", "Некорректный порядок страниц"))
        return
    await manager.broadcast(
        room,
        {"type": "workspace_reordered", "workspaceIds": message.workspaceIds},
    )


async def _handle_workspace_pull(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspacePull,
) -> None:
    if user.role != "teacher":
        await manager.send_to(
            user, _error("forbidden", "Перемещать участников может только учитель")
        )
        return
    moved = await manager.pull_users(room, user, client_ids=message.clientIds, all=message.all)
    if moved == 0:
        await manager.send_to(user, _error("user_not_found", "Участник не найден"))


async def _handle_workspace_move_ack(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceMoveAck,
) -> None:
    await manager.handle_move_ack(room, user, message.requestId)
