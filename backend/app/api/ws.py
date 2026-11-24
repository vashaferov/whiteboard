"""WebSocket endpoint: room presence, drawing sync, roles and rate limits."""

from __future__ import annotations

import copy
import logging
import re
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.config import Settings
from app.models.schemas import (
    OBJECT_ID_PATTERN,
    ROOM_ID_PATTERN,
    BoardResize,
    Clear,
    ClientMessage,
    ConnectorAdd,
    Cursor,
    FrameAdd,
    FrameMove,
    FrameStyle,
    ImageAdd,
    Kick,
    ObjectDelete,
    ObjectLock,
    ObjectsDelete,
    ObjectsMove,
    ObjectTransform,
    ObjectUpdate,
    PresentationSlide,
    SetInvisible,
    ShapeAdd,
    StrokeEnd,
    StrokePoint,
    StrokeStart,
    TextAdd,
    TextStyle,
    TextUpdate,
    Undo,
    WorkspaceBackground,
    WorkspaceCanvas,
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
from app.services.access import can_access_room
from app.services.accounts import AccountStore
from app.services.auth import SESSION_COOKIE, is_staff
from app.services.room_manager import (
    BOARD_RATIO,
    STAFF_ROLES,
    ConnectedUser,
    RateLimiter,
    Room,
    RoomManager,
)
from app.services.workspaces import PRESENTATION_KIND

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_POINTS_PER_STROKE = 20000
MAX_ACTIVE_STROKES = 8
FLOW_SHAPES = {"process", "decision", "terminator"}


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
    return is_staff(user.role) or obj.get("author") == user.id


def _is_presentation(room: Room, workspace_id: str) -> bool:
    workspace = room.get_workspace(workspace_id)
    return bool(workspace and workspace.get("kind") == PRESENTATION_KIND)


PRESENTATION_ALLOWED = {
    "stroke_start",
    "stroke_point",
    "stroke_end",
    "cursor",
    "presentation_slide",
    "undo",
    "kick",
    "workspace_switch",
    "workspace_create",
    "workspace_rename",
    "workspace_delete",
    "workspace_reorder",
    "workspace_pull",
    "workspace_move_ack",
}


def _locked_for(room: Room, obj: dict[str, Any]) -> bool:
    """A locked object and the children of a locked frame reject every edit."""
    if obj.get("locked"):
        return True
    frame_id = obj.get("frameId")
    frame = room.get_object(str(frame_id)) if frame_id else None
    return bool(frame and frame.get("locked"))


def _push_history(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    entry: dict[str, Any],
) -> None:
    workspace = room.get_workspace(user.workspace_id)
    if workspace and workspace.get("kind") == PRESENTATION_KIND:
        entry["slide"] = int(workspace.get("slideIndex", 0) or 0)
    manager.push_history(room, user.id, user.workspace_id, entry)


def _push_create(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    object_id: str,
    fields: dict[str, Any] | None = None,
) -> None:
    _push_history(
        manager,
        room,
        user,
        {"created": [object_id], "fields": fields or {}},
    )


def _push_fields(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    objects: list[dict[str, Any] | None],
    names: tuple[str, ...],
) -> None:
    fields = {
        str(obj["id"]): {name: copy.deepcopy(obj.get(name)) for name in names}
        for obj in objects
        if obj is not None
    }
    _push_history(manager, room, user, {"fields": fields})


def _push_delete(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    objects: list[dict[str, Any]],
) -> None:
    deleted = [
        {"index": room.objects.index(obj), "object": copy.deepcopy(obj)}
        for obj in objects
        if obj in room.objects
    ]
    _push_history(manager, room, user, {"deleted": deleted})


def _frame_rect(frame: dict[str, Any]) -> tuple[float, float, float, float]:
    x = float(frame.get("x", 0))
    y = float(frame.get("y", 0))
    width = float(frame.get("width", 0))
    height = float(frame.get("height", 0))
    return min(x, x + width), min(y, y + height), abs(width), abs(height)


def _object_anchor(obj: dict[str, Any]) -> tuple[float, float] | None:
    obj_type = obj.get("type")
    x = float(obj.get("x", 0))
    y = float(obj.get("y", 0))
    if obj_type == "text":
        return x, y
    if obj_type in ("shape", "image"):
        width = float(obj.get("width", 0))
        height = float(obj.get("height", 0))
        return x + width / 2, y + height / 2
    return None


def _frame_contains(frame: dict[str, Any], point: tuple[float, float]) -> bool:
    left, top, width, height = _frame_rect(frame)
    return left <= point[0] <= left + width and top <= point[1] <= top + height


def _attach_to_frame(room: Room, obj: dict[str, Any], user: ConnectedUser) -> str | None:
    """Attach an object to the latest frame under its anchor; detach otherwise."""
    if obj.get("type") in ("frame", "connector"):
        return None
    anchor = _object_anchor(obj)
    if anchor is None:
        return None
    best: dict[str, Any] | None = None
    for candidate in room.objects:
        if candidate.get("type") != "frame":
            continue
        if candidate.get("workspaceId") != obj.get("workspaceId"):
            continue
        if _locked_for(room, candidate):
            continue
        if not _frame_contains(candidate, anchor):
            continue
        if best is None or candidate.get("seq", 0) > best.get("seq", 0):
            best = candidate
    if best is None:
        obj.pop("frameId", None)
        return None
    obj["frameId"] = best["id"]
    return best["id"]


def _capture_into_frame(
    room: Room, frame: dict[str, Any], user: ConnectedUser
) -> tuple[list[str], dict[str, Any]]:
    """Capture free objects inside a frame; return their ids and previous ``frameId``s."""
    if _locked_for(room, frame):
        return [], {}
    captured: list[str] = []
    previous: dict[str, Any] = {}
    for obj in room.objects:
        if obj is frame or obj.get("type") in ("frame", "connector"):
            continue
        if obj.get("frameId") is not None:
            continue
        if obj.get("workspaceId") != frame.get("workspaceId"):
            continue
        if _locked_for(room, obj):
            continue
        anchor = _object_anchor(obj)
        if anchor is None or not _frame_contains(frame, anchor):
            continue
        previous[str(obj["id"])] = {"frameId": obj.get("frameId")}
        obj["frameId"] = frame["id"]
        captured.append(str(obj["id"]))
    return captured, previous


def _deletion_cascade(room: Room, obj: dict[str, Any]) -> list[str]:
    ids: list[str] = []

    def connector_ids(block_id: str) -> None:
        for candidate in room.objects:
            if candidate.get("type") == "connector" and (
                candidate.get("fromId") == block_id or candidate.get("toId") == block_id
            ):
                ids.append(str(candidate["id"]))

    if obj.get("type") == "shape" and obj.get("shapeType") in FLOW_SHAPES:
        connector_ids(str(obj["id"]))
    elif obj.get("type") == "frame":
        for child in list(room.objects):
            if child.get("frameId") != obj["id"]:
                continue
            ids.append(str(child["id"]))
            if child.get("type") == "shape" and child.get("shapeType") in FLOW_SHAPES:
                connector_ids(str(child["id"]))
    return list(dict.fromkeys(ids))


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
    workspace: str = Query(default=""),
) -> None:
    settings: Settings = websocket.app.state.settings
    manager: RoomManager = websocket.app.state.manager
    accounts: AccountStore = websocket.app.state.accounts

    # Accept first so close codes reach browsers (a pre-accept close is an HTTP 403).
    await websocket.accept()
    metrics.WS_CONNECTIONS.inc()
    user: ConnectedUser | None = None
    try:
        if not re.fullmatch(ROOM_ID_PATTERN, room_id):
            await websocket.close(code=4400, reason="invalid_room")
            return

        user = await _authenticate(websocket, accounts, settings, room_id)
        if user is None:
            return

        room = await manager.join(room_id, user)
        if workspace and room.get_workspace(workspace) is not None:
            user.workspace_id = workspace
        else:
            user.workspace_id = room.workspace_ids()[0]
        users = await manager.list_users(room, viewer=user)

        await websocket.send_json(
            {
                "type": "init",
                "clientId": user.id,
                "roomId": room.id,
                "role": user.role,
                "users": users,
                "objects": manager.objects_for(room, user.workspace_id),
                "userCount": len(users),
                "invisible": user.invisible,
                "board": dict(room.board),
                "permissions": permissions_for(user.role).model_dump(),
                "workspaces": room.workspace_list(),
                "workspaceId": user.workspace_id,
            }
        )
        await manager.publish_users_changed(room)
        if user.invisible:
            for other in list(room.users.values()):
                if other.id != user.id and other.role in STAFF_ROLES:
                    await manager.send_to(other, {"type": "user_joined", "user": user.public()})
        else:
            await manager.broadcast(
                room,
                {"type": "user_joined", "user": user.public()},
                exclude=user.id,
            )
        await _receive_loop(websocket, manager, room, user, settings)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - keep the server alive on malformed clients
        logger.exception(
            "WebSocket failure in room %s for user %s",
            room_id,
            user.id if user is not None else "?",
        )
    finally:
        if user is not None:
            await manager.leave(room_id, user.id)
        metrics.WS_CONNECTIONS.dec()


async def _authenticate(
    websocket: WebSocket,
    accounts: AccountStore,
    settings: Settings,
    room_id: str,
) -> ConnectedUser | None:
    """Resolve the socket owner from the session cookie."""
    session_id = websocket.cookies.get(SESSION_COOKIE)
    account = await accounts.get_session_user(session_id) if session_id else None
    if account is None or account.status != "active":
        await websocket.close(code=4401, reason="unauthorized")
        return None
    room = await accounts.get_room(room_id)
    if room is None:
        await websocket.close(code=4404, reason="room_not_found")
        return None
    granted = await accounts.has_room_access(room_id, account.id)
    if not can_access_room(account, room, granted=granted):
        await websocket.close(code=4403, reason="forbidden")
        return None
    return ConnectedUser(
        id=account.id,
        name=account.name,
        role=account.role,
        color=account.color,
        websocket=websocket,
        limiter=_limiter(settings),
        invisible=account.role == "admin",
    )


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

    if _is_presentation(room, user.workspace_id) and kind not in PRESENTATION_ALLOWED:
        await manager.send_to(
            user,
            _error("presentation_view_only", "На презентации можно только рисовать кистью"),
        )
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
    elif isinstance(message, ConnectorAdd):
        await _handle_connector_add(manager, room, user, message)
    elif isinstance(message, FrameAdd):
        await _handle_frame_add(manager, room, user, message)
    elif isinstance(message, FrameMove):
        await _handle_frame_move(manager, room, user, message)
    elif isinstance(message, FrameStyle):
        await _handle_frame_style(manager, room, user, message)
    elif isinstance(message, ObjectTransform):
        await _handle_object_transform(manager, room, user, message)
    elif isinstance(message, ObjectsDelete):
        await _handle_objects_delete(manager, room, user, message)
    elif isinstance(message, ObjectsMove):
        await _handle_objects_move(manager, room, user, message)
    elif isinstance(message, TextUpdate):
        await _handle_text_update(manager, room, user, message)
    elif isinstance(message, TextStyle):
        await _handle_text_style(manager, room, user, message)
    elif isinstance(message, BoardResize):
        await _handle_board_resize(manager, room, user, message)
    elif isinstance(message, WorkspaceCanvas):
        await _handle_workspace_canvas(manager, room, user, message)
    elif isinstance(message, WorkspaceBackground):
        await _handle_workspace_background(manager, room, user, message)
    elif isinstance(message, ObjectDelete):
        await _handle_object_delete(manager, room, user, message)
    elif isinstance(message, ObjectLock):
        await _handle_object_lock(manager, room, user, message)
    elif isinstance(message, Undo):
        await _handle_undo(manager, room, user, message)
    elif isinstance(message, SetInvisible):
        await _handle_set_invisible(manager, room, user, message)
    elif isinstance(message, Cursor):
        await _handle_cursor(manager, room, user, message)
    elif isinstance(message, Clear):
        await _handle_clear(manager, room, user, message)
    elif isinstance(message, Kick):
        await _handle_kick(manager, room, user, message)
    elif isinstance(message, WorkspaceSwitch):
        await _handle_workspace_switch(manager, room, user, message)
    elif isinstance(message, PresentationSlide):
        await _handle_presentation_slide(manager, room, user, message)
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

    workspace = room.get_workspace(user.workspace_id)
    presentation = bool(workspace and workspace.get("kind") == PRESENTATION_KIND)
    if presentation and (not is_staff(user.role) or message.tool != "brush"):
        await manager.send_to(
            user,
            _error("presentation_brush_only", "На презентации доступна только кисть учителя"),
        )
        return

    fields: dict[str, Any] = {
        "tool": message.tool,
        "color": message.color,
        "width": message.width,
        "points": [[message.point.x, message.point.y]],
    }
    if presentation:
        fields["slide"] = int(workspace.get("slideIndex", 0) or 0)
    obj = _new_object(
        user,
        message.objectId,
        "stroke",
        **fields,
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
    _push_create(manager, room, user, message.objectId)
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
    _attach_to_frame(room, obj, user)
    manager.add_object(room, obj, user.workspace_id)
    _push_create(manager, room, user, message.objectId)
    await manager.broadcast(
        room,
        {"type": "shape_add", "id": user.id, "object": obj, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_connector_add(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ConnectorAdd,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    if room.get_object(message.objectId) is not None:
        return
    if message.fromId == message.toId:
        await manager.send_to(
            user, _error("invalid_message", "Стрелка не может соединять блок с собой")
        )
        return
    for block_id in (message.fromId, message.toId):
        block = room.get_object(block_id)
        if (
            block is None
            or block.get("workspaceId") != user.workspace_id
            or block.get("type") != "shape"
            or block.get("shapeType") not in FLOW_SHAPES
        ):
            await manager.send_to(
                user,
                _error("invalid_message", "Стрелка соединяет только блоки схемы"),
            )
            return
    if not manager.has_capacity(room):
        await manager.send_to(user, _error("room_full", "Достигнут лимит объектов на доске"))
        return
    obj = _new_object(
        user,
        message.objectId,
        "connector",
        fromId=message.fromId,
        toId=message.toId,
        color=message.color,
        strokeWidth=message.strokeWidth,
    )
    manager.add_object(room, obj, user.workspace_id)
    _push_create(manager, room, user, message.objectId)
    await manager.broadcast(
        room,
        {
            "type": "connector_add",
            "id": user.id,
            "object": obj,
            "workspaceId": user.workspace_id,
        },
    )


async def _handle_frame_add(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: FrameAdd,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    if room.get_object(message.objectId) is not None:
        return
    if not manager.has_capacity(room):
        await manager.send_to(user, _error("room_full", "Достигнут лимит объектов на доске"))
        return
    left = min(message.x, message.x + message.width)
    top = min(message.y, message.y + message.height)
    obj = _new_object(
        user,
        message.objectId,
        "frame",
        x=left,
        y=top,
        width=abs(message.width),
        height=abs(message.height),
        fill=message.fill,
        pattern=message.pattern,
        stroke=message.stroke,
        strokeWidth=message.strokeWidth,
        rotation=0,
    )
    manager.add_object(room, obj, user.workspace_id)
    await manager.broadcast(
        room,
        {"type": "frame_add", "id": user.id, "object": obj, "workspaceId": user.workspace_id},
        exclude=user.id,
        workspace_id=user.workspace_id,
    )
    captured, previous = _capture_into_frame(room, obj, user)
    _push_create(manager, room, user, message.objectId, previous)
    if captured:
        manager.mark_dirty(room)
        await manager.broadcast(
            room,
            {
                "type": "frame_captured",
                "frameId": obj["id"],
                "objectIds": captured,
                "workspaceId": user.workspace_id,
            },
            workspace_id=user.workspace_id,
        )


async def _handle_frame_move(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: FrameMove,
) -> None:
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if obj.get("type") != "frame":
        await manager.send_to(user, _error("invalid_message", "Объект не является фреймом"))
        return
    if _locked_for(room, obj) or any(
        _locked_for(room, child) for child in room.objects if child.get("frameId") == obj["id"]
    ):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно двигать только свои фреймы"))
        return

    _push_fields(
        manager,
        room,
        user,
        [
            obj,
            *(
                child
                for child in room.objects
                if child.get("frameId") == obj["id"] and child.get("type") != "connector"
            ),
        ],
        ("x", "y"),
    )
    dx = message.x - float(obj.get("x", 0))
    dy = message.y - float(obj.get("y", 0))
    obj["x"] = message.x
    obj["y"] = message.y
    children: list[dict[str, Any]] = []
    for child in room.objects:
        if child.get("frameId") != obj["id"]:
            continue
        if child.get("type") == "connector":
            continue
        child["x"] = float(child.get("x", 0)) + dx
        child["y"] = float(child.get("y", 0)) + dy
        children.append({"id": child["id"], "x": child["x"], "y": child["y"]})
    manager.mark_dirty(room)
    await manager.broadcast(
        room,
        {
            "type": "frame_moved",
            "frameId": obj["id"],
            "x": obj["x"],
            "y": obj["y"],
            "children": children,
            "workspaceId": user.workspace_id,
        },
        workspace_id=user.workspace_id,
    )


async def _handle_frame_style(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: FrameStyle,
) -> None:
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if obj.get("type") != "frame":
        await manager.send_to(user, _error("invalid_message", "Объект не является фреймом"))
        return
    if _locked_for(room, obj):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно менять только свои фреймы"))
        return
    _push_fields(manager, room, user, [obj], ("fill", "pattern"))
    manager.update_object_fields(room, message.objectId, fill=message.fill, pattern=message.pattern)
    await manager.broadcast(
        room,
        {
            "type": "frame_style",
            "objectId": message.objectId,
            "fill": message.fill,
            "pattern": message.pattern,
            "workspaceId": user.workspace_id,
        },
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
        fontFamily=message.fontFamily,
        bold=message.bold,
        italic=message.italic,
        underline=message.underline,
    )
    _attach_to_frame(room, obj, user)
    manager.add_object(room, obj, user.workspace_id)
    _push_create(manager, room, user, message.objectId)
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
    _attach_to_frame(room, obj, user)
    manager.add_object(room, obj, user.workspace_id)
    _push_create(manager, room, user, message.objectId)
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
    if _locked_for(room, obj):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно перемещать только свои объекты"))
        return
    _push_fields(manager, room, user, [obj], ("x", "y", "frameId"))
    manager.update_object(room, message.objectId, message.x, message.y)
    _attach_to_frame(room, obj, user)
    await manager.broadcast(
        room,
        {
            "type": "object_update",
            "id": user.id,
            "objectId": message.objectId,
            "x": message.x,
            "y": message.y,
            "frameId": obj.get("frameId"),
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
    if _locked_for(room, obj) or (
        obj.get("type") == "frame"
        and any(
            _locked_for(room, child) for child in room.objects if child.get("frameId") == obj["id"]
        )
    ):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
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
        if (
            obj.get("type") == "shape"
            and obj.get("shapeType") in FLOW_SHAPES
            or obj.get("type") == "frame"
        ):
            fields["rotation"] = 0
        if message.width is not None and message.width != 0:
            fields["width"] = message.width
        if message.height is not None and message.height != 0:
            fields["height"] = message.height

    names = ("x", "y", "frameId")
    names += (
        ("rotation", "fontSize")
        if obj.get("type") == "text"
        else (
            "width",
            "height",
            "rotation",
        )
    )
    _push_fields(manager, room, user, [obj], names)
    updated = manager.update_object_fields(room, message.objectId, **fields)
    if updated is None:
        return
    _attach_to_frame(room, updated, user)
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
    is_block = obj.get("type") == "shape" and obj.get("shapeType") in FLOW_SHAPES
    if obj.get("type") != "text" and not is_block:
        await manager.send_to(user, _error("not_text", "Объект не является текстом"))
        return
    if _locked_for(room, obj):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно изменять только свои объекты"))
        return
    content = message.content.strip()
    if not content:
        await manager.send_to(user, _error("invalid_message", "Текст не может быть пустым"))
        return
    _push_fields(manager, room, user, [obj], ("content",))
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


async def _handle_text_style(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: TextStyle,
) -> None:
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if obj.get("type") != "text":
        await manager.send_to(user, _error("not_text", "Объект не является текстом"))
        return
    if _locked_for(room, obj):
        await manager.send_to(user, _error("locked", "Объект заблокирован учителем"))
        return
    if not _can_edit_object(user, obj):
        await manager.send_to(user, _error("forbidden", "Можно менять только свой текст"))
        return
    patch = message.model_dump(exclude_none=True, exclude={"type", "objectId", "workspaceId"})
    _push_fields(manager, room, user, [obj], tuple(patch))
    updated = manager.update_object_fields(room, message.objectId, **patch)
    if updated is None:
        return
    await manager.broadcast(
        room,
        {
            "type": "text_style",
            "id": user.id,
            "object": updated,
            "workspaceId": user.workspace_id,
        },
        exclude=user.id,
        workspace_id=user.workspace_id,
    )


async def _handle_board_resize(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: BoardResize,
) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Менять размер может только учитель"))
        return
    if max(message.width / message.height, message.height / message.width) > BOARD_RATIO:
        await manager.send_to(user, _error("invalid_message", "Слишком вытянутый холст"))
        return
    if not manager.set_board(room, message.width, message.height):
        return
    await manager.broadcast(
        room,
        {"type": "board_resize", "width": message.width, "height": message.height},
    )


async def _handle_objects_delete(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ObjectsDelete,
) -> None:
    targets: dict[str, dict[str, Any]] = {}
    for object_id in dict.fromkeys(message.objectIds):
        obj = room.get_object(object_id)
        if obj is None or obj.get("workspaceId") != user.workspace_id:
            continue
        if _locked_for(room, obj):
            await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
            return
        if obj.get("type") == "frame" and any(
            _locked_for(room, child) for child in room.objects if child.get("frameId") == obj["id"]
        ):
            await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
            return
        if not (is_staff(user.role) or obj.get("author") == user.id):
            await manager.send_to(user, _error("forbidden", "Удалять можно только свои объекты"))
            return
        if obj.get("type") == "frame" and not is_staff(user.role):
            children = [child for child in room.objects if child.get("frameId") == obj["id"]]
            if any(child.get("author") != user.id for child in children):
                await manager.send_to(user, _error("forbidden", "Во фрейме есть чужие объекты"))
                return
        targets[obj["id"]] = obj
        for cascade_id in _deletion_cascade(room, obj):
            child = room.get_object(cascade_id)
            if child is not None:
                targets[cascade_id] = child

    if not targets:
        return
    _push_delete(manager, room, user, list(targets.values()))
    for object_id in targets:
        manager.delete_object(room, object_id)
        await manager.broadcast(
            room,
            {
                "type": "object_delete",
                "id": user.id,
                "objectId": object_id,
                "workspaceId": user.workspace_id,
            },
            exclude=user.id,
            workspace_id=user.workspace_id,
        )


async def _handle_objects_move(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ObjectsMove,
) -> None:
    direct = {update.objectId: update for update in message.updates}
    affected: dict[str, dict[str, Any]] = {}
    deltas: dict[str, tuple[float, float]] = {}
    for object_id, update in direct.items():
        obj = room.get_object(object_id)
        if obj is None or obj.get("workspaceId") != user.workspace_id:
            continue
        if _locked_for(room, obj) or not _can_edit_object(user, obj):
            continue
        old_x = float(obj.get("x", 0) or 0)
        old_y = float(obj.get("y", 0) or 0)
        deltas[object_id] = (update.x - old_x, update.y - old_y)
        affected[object_id] = obj
        if obj.get("type") == "frame":
            for child in room.objects:
                if child.get("frameId") != object_id or child.get("type") == "connector":
                    continue
                affected[child["id"]] = child
                deltas[child["id"]] = deltas[object_id]

    if not affected:
        return
    _push_fields(manager, room, user, list(affected.values()), ("x", "y", "frameId"))
    for object_id, (dx, dy) in deltas.items():
        obj = affected.get(object_id)
        if obj is None:
            continue
        obj["x"] = float(obj.get("x", 0) or 0) + dx
        obj["y"] = float(obj.get("y", 0) or 0) + dy
        if object_id in direct and obj.get("type") != "frame":
            _attach_to_frame(room, obj, user)
        manager.mark_dirty(room)
        await manager.broadcast(
            room,
            {
                "type": "object_update",
                "id": user.id,
                "objectId": object_id,
                "x": obj["x"],
                "y": obj["y"],
                "frameId": obj.get("frameId"),
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
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None:
        return
    if _locked_for(room, obj):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
        return
    if obj.get("type") == "frame" and any(
        _locked_for(room, child) for child in room.objects if child.get("frameId") == obj["id"]
    ):
        await manager.send_to(user, _error("locked", "Элемент заблокирован учителем"))
        return
    if not (is_staff(user.role) or obj.get("author") == user.id):
        await manager.send_to(user, _error("forbidden", "Удалять можно только свои объекты"))
        return
    if obj.get("type") == "frame" and not is_staff(user.role):
        children = [child for child in room.objects if child.get("frameId") == obj["id"]]
        if any(child.get("author") != user.id for child in children):
            await manager.send_to(user, _error("forbidden", "Во фрейме есть чужие объекты"))
            return

    cascade_ids = _deletion_cascade(room, obj)
    targets = [obj, *(room.get_object(cascade_id) for cascade_id in cascade_ids)]
    _push_delete(manager, room, user, [target for target in targets if target is not None])
    for cascade_id in cascade_ids:
        manager.delete_object(room, cascade_id)

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
    for cascade_id in cascade_ids:
        await manager.broadcast(
            room,
            {
                "type": "object_delete",
                "id": user.id,
                "objectId": cascade_id,
                "workspaceId": user.workspace_id,
            },
            workspace_id=user.workspace_id,
        )


async def _handle_undo(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: Undo,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    workspace = room.get_workspace(user.workspace_id)
    presentation = bool(workspace and workspace.get("kind") == PRESENTATION_KIND)
    if presentation and not is_staff(user.role):
        await manager.send_to(
            user,
            _error("presentation_view_only", "На презентации доступна только кисть учителя"),
        )
        return
    slide_index = int(workspace.get("slideIndex", 0) or 0) if presentation else None
    for _ in range(50):
        entry = manager.pop_history(room, user.id, user.workspace_id, slide_index)
        if entry is None:
            break
        removed: list[str] = []
        objects: list[dict[str, Any]] = []
        if entry.get("created"):
            created = _undo_created_apply(user, room, entry)
            if created is None:
                continue
            removed = created
        elif entry.get("deleted"):
            deleted = _undo_deleted_apply(user, room, entry)
            if deleted is None:
                continue
            removed, objects = deleted
        elif entry.get("fields"):
            if not _undo_fields_apply(user, room, entry):
                continue
        else:
            continue
        for object_id in entry.get("fields") or {}:
            obj = room.get_object(object_id)
            if obj is not None:
                objects.append({"index": None, "object": copy.deepcopy(obj)})
        manager.mark_dirty(room)
        await manager.broadcast(
            room,
            {
                "type": "objects_restored",
                "removedIds": removed,
                "objects": objects,
                "workspaceId": user.workspace_id,
            },
            workspace_id=user.workspace_id,
        )
        return
    await manager.send_to(user, _error("undo_empty", "Нечего отменять"))


def _undo_fields_apply(user: ConnectedUser, room: Room, entry: dict[str, Any]) -> bool:
    fields: dict[str, dict[str, Any]] = entry.get("fields") or {}
    targets: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for object_id, patch in fields.items():
        obj = room.get_object(object_id)
        if obj is None:
            continue
        if _locked_for(room, obj) and not (is_staff(user.role) and set(patch) <= {"locked"}):
            return False
        targets.append((obj, patch))
    if not targets:
        return False
    for obj, patch in targets:
        obj.update(copy.deepcopy(patch))
    return True


def _undo_created_apply(user: ConnectedUser, room: Room, entry: dict[str, Any]) -> list[str] | None:
    created: list[str] = entry.get("created") or []
    targets = [obj for obj in (room.get_object(object_id) for object_id in created) if obj]
    if not targets:
        return None
    field_targets = [room.get_object(object_id) for object_id in (entry.get("fields") or {})]
    if any(target is not None and _locked_for(room, target) for target in field_targets):
        return None
    removed: list[str] = []
    for obj in targets:
        if _locked_for(room, obj):
            return None
        if obj.get("type") == "frame" and any(
            child.get("frameId") == obj["id"] and _locked_for(room, child) for child in room.objects
        ):
            return None
        cascade = [] if obj.get("type") == "frame" else _deletion_cascade(room, obj)
        removed.extend([str(obj["id"]), *cascade])
    for object_id in removed:
        room.remove_object(object_id)
    for object_id, patch in (entry.get("fields") or {}).items():
        target = room.get_object(object_id)
        if target is not None:
            target.update(copy.deepcopy(patch))
    return removed


def _undo_deleted_apply(
    user: ConnectedUser, room: Room, entry: dict[str, Any]
) -> tuple[list[str], list[dict[str, Any]]] | None:
    deleted: list[dict[str, Any]] = entry.get("deleted") or []
    absent = [item for item in deleted if room.get_object(str(item["object"]["id"])) is None]
    if not absent:
        return None
    restored: list[dict[str, Any]] = []
    for item in sorted(absent, key=lambda item: item["index"]):
        obj = copy.deepcopy(item["object"])
        room.objects.insert(min(item["index"], len(room.objects)), obj)
        room.index[str(obj["id"])] = obj
        room.seq = max(room.seq, int(obj.get("seq", 0) or 0))
        restored.append({"index": item["index"], "object": obj})
    return [], restored


async def _handle_object_lock(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: ObjectLock,
) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Блокировать может только учитель"))
        return
    obj = await _check_object_workspace(manager, room, user, message)
    if obj is None or bool(obj.get("locked")) == message.locked:
        return
    _push_fields(manager, room, user, [obj], ("locked",))
    manager.update_object_fields(room, message.objectId, locked=message.locked)
    await manager.broadcast(
        room,
        {
            "type": "object_lock",
            "objectId": message.objectId,
            "locked": message.locked,
            "workspaceId": user.workspace_id,
        },
        workspace_id=user.workspace_id,
    )


async def _handle_set_invisible(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: SetInvisible,
) -> None:
    if user.role != "admin":
        await manager.send_to(user, _error("forbidden", "Невидимость доступна администратору"))
        return
    await manager.set_invisible(room, user, message.invisible)


async def _handle_cursor(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: Cursor,
) -> None:
    if not await _check_workspace(manager, user, message):
        return
    if user.invisible:
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
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Очистить доску может только учитель"))
        return
    if not await _check_workspace(manager, user, message):
        return
    manager.clear_room(room, user.workspace_id)
    manager.clear_history(room)
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
    if not is_staff(user.role):
        await manager.send_to(
            user, _error("forbidden", "Отключать участников может только учитель")
        )
        return
    if not re.fullmatch(OBJECT_ID_PATTERN, message.clientId) or message.clientId == user.id:
        return
    if not await manager.kick(room.id, message.clientId):
        await manager.send_to(user, _error("user_not_found", "Участник не найден"))
        return
    manager.clear_history(room, message.clientId)


async def _handle_workspace_canvas(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceCanvas,
) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Менять холст может только учитель"))
        return
    if not await _check_workspace(manager, user, message):
        return
    workspace = room.get_workspace(user.workspace_id)
    if workspace is None or workspace.get("kind") == PRESENTATION_KIND:
        await manager.send_to(user, _error("invalid_message", "Холст презентации задаёт слайд"))
        return
    canvas = None
    if message.mode == "fixed":
        if message.width is None or message.height is None:
            await manager.send_to(user, _error("invalid_message", "Укажите ширину и высоту"))
            return
        ratio = max(message.width / message.height, message.height / message.width)
        if ratio > 4:
            await manager.send_to(user, _error("invalid_message", "Слишком вытянутый холст"))
            return
        canvas = {"mode": "fixed", "width": message.width, "height": message.height}
    if canvas is None:
        workspace.pop("canvas", None)
    else:
        workspace["canvas"] = canvas
    manager.mark_dirty(room)
    await manager.broadcast(
        room,
        {
            "type": "workspace_canvas",
            "workspaceId": user.workspace_id,
            "canvas": canvas,
        },
        workspace_id=user.workspace_id,
    )


async def _handle_workspace_background(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceBackground,
) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Цвет холста может менять только учитель"))
        return
    if not await _check_workspace(manager, user, message):
        return
    workspace = room.get_workspace(user.workspace_id)
    if workspace is None or workspace.get("kind") == PRESENTATION_KIND:
        await manager.send_to(
            user, _error("invalid_message", "Страница презентации не имеет холста")
        )
        return
    color = message.color.lower() if message.color else None
    if color is None:
        workspace.pop("background", None)
    else:
        workspace["background"] = color
    manager.mark_dirty(room)
    await manager.broadcast(
        room,
        {
            "type": "workspace_background",
            "workspaceId": user.workspace_id,
            "color": color,
        },
        workspace_id=user.workspace_id,
    )


async def _handle_workspace_switch(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceSwitch,
) -> None:
    if not await manager.switch_workspace(room, user, message.workspaceId):
        await manager.send_to(user, _error("workspace_not_found", "Страница не найдена"))


async def _handle_presentation_slide(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: PresentationSlide,
) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Переключать слайды может только учитель"))
        return
    if not await _check_workspace(manager, user, message):
        return
    workspace = room.get_workspace(user.workspace_id)
    if workspace is None or workspace.get("kind") != PRESENTATION_KIND:
        await manager.send_to(user, _error("invalid_message", "Страница не является презентацией"))
        return
    slides = workspace.get("slides") or []
    if not 0 <= message.slideIndex < len(slides):
        await manager.send_to(user, _error("invalid_message", "Слайд не найден"))
        return
    if workspace.get("slideIndex") == message.slideIndex:
        return

    await manager.finalize_user_strokes(room, user)
    workspace["slideIndex"] = message.slideIndex
    manager.mark_dirty(room)
    await manager.broadcast(
        room,
        {
            "type": "presentation_slide",
            "workspaceId": user.workspace_id,
            "slideIndex": message.slideIndex,
            "objects": manager.objects_for(room, user.workspace_id),
        },
        workspace_id=user.workspace_id,
    )


async def _handle_workspace_create(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceCreate,
    settings: Settings,
) -> None:
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Создавать страницы может только учитель"))
        return
    if len(room.workspaces) >= settings.max_workspaces_per_room:
        await manager.send_to(user, _error("workspace_limit", "Достигнут лимит страниц"))
        return
    if message.kind == PRESENTATION_KIND:
        if not message.slides:
            await manager.send_to(user, _error("invalid_presentation", "В презентации нет слайдов"))
            return
        for url in message.slides:
            if not await manager.images.exists(url):
                await manager.send_to(user, _error("invalid_presentation", "Слайд не найден"))
                return
        workspace = manager.create_workspace(
            room,
            message.name or "Презентация",
            kind=PRESENTATION_KIND,
            slides=message.slides,
        )
    else:
        workspace = manager.create_workspace(room, message.name)
    await manager.broadcast(room, {"type": "workspace_created", "workspace": workspace})
    await manager.switch_workspace(room, user, workspace["id"], reason="create")


async def _handle_workspace_rename(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceRename,
) -> None:
    if not is_staff(user.role):
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
    if not is_staff(user.role):
        await manager.send_to(user, _error("forbidden", "Удалять страницы может только учитель"))
        return
    if room.get_workspace(message.workspaceId) is None:
        await manager.send_to(user, _error("workspace_not_found", "Страница не найдена"))
        return
    deleted, fallback = manager.delete_workspace(room, message.workspaceId)
    if deleted is None:
        await manager.send_to(user, _error("last_workspace", "Нельзя удалить последнюю страницу"))
        return
    await manager.broadcast(
        room,
        {"type": "workspace_deleted", "workspaceId": deleted["id"], "fallbackId": fallback},
    )
    manager.clear_history(room, workspace_id=deleted["id"])
    await manager.move_users_from_deleted(room, deleted["id"], fallback)


async def _handle_workspace_reorder(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceReorder,
) -> None:
    if not is_staff(user.role):
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
    if not is_staff(user.role):
        await manager.send_to(
            user, _error("forbidden", "Перемещать участников может только учитель")
        )
        return
    moved = await manager.pull_users(room, user, client_ids=message.clientIds, all=message.all)
    # "Pull everyone" in a room without students is a no-op, not an error.
    if moved == 0 and not message.all:
        await manager.send_to(user, _error("user_not_found", "Участник не найден"))


async def _handle_workspace_move_ack(
    manager: RoomManager,
    room: Room,
    user: ConnectedUser,
    message: WorkspaceMoveAck,
) -> None:
    await manager.handle_move_ack(room, user, message.requestId)
