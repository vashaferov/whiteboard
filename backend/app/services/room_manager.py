"""Room registry: in-memory by default, shared through Redis when configured.

The local ``Room`` objects own the WebSocket connections. When Redis is enabled,
object state, presence and events are additionally written to Redis so several
application instances see the same lesson: state lives in a per-room hash,
presence in a hash with timestamps, and live events go through Pub/Sub.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.config import Settings
from app.services.images import ImageStorage, LocalImageStorage
from app.services.storage import SnapshotStore
from app.services.workspaces import (
    DEFAULT_WORKSPACE_ID,
    assign_orphan_objects,
    new_workspace_id,
    next_workspace_name,
    normalize_workspaces,
)

logger = logging.getLogger(__name__)

ADD_EVENTS = {"shape_add", "text_add", "image_add", "stroke_end", "connector_add"}
OBJECT_EVENTS = {"object_transform", "text_update"}

# Events whose delivery is filtered by the recipient's current workspace. Room-level
# structural events (workspace_* metadata, presence) are intentionally absent.
WORKSPACE_SCOPED_EVENTS = {
    "stroke_start",
    "stroke_point",
    "stroke_end",
    "shape_add",
    "text_add",
    "image_add",
    "connector_add",
    "object_update",
    "object_transform",
    "text_update",
    "object_delete",
    "clear",
    "cursor",
    "cursor_remove",
}


def _redis_object_workspace(value: str) -> str | None:
    """Return the ``workspaceId`` stored in a Redis object JSON payload, if any."""
    try:
        obj = json.loads(value)
    except (TypeError, ValueError):
        return None
    if isinstance(obj, dict):
        workspace_id = obj.get("workspaceId")
        return workspace_id if isinstance(workspace_id, str) else None
    return None


class SupportsSend(Protocol):
    async def send_json(self, data: Any) -> None: ...  # pragma: no cover - protocol

    async def close(
        self, code: int = 1000, reason: str | None = None
    ) -> None: ...  # pragma: no cover


class RateLimiter:
    """Simple sliding-window limiter: at most N messages per second per category."""

    def __init__(self, limits: dict[str, int]) -> None:
        self._limits = limits
        self._events: dict[str, deque[float]] = {}

    def allow(self, category: str) -> bool:
        limit = self._limits.get(category, self._limits.get("default", 30))
        if limit <= 0:
            return True
        now = time.monotonic()
        events = self._events.setdefault(category, deque())
        while events and now - events[0] > 1.0:
            events.popleft()
        if len(events) >= limit:
            return False
        events.append(now)
        return True


@dataclass(slots=True)
class PendingMove:
    """A prepared workspace move waiting for the student's ack (or a timeout)."""

    request_id: str
    workspace_id: str
    by: str | None
    task: asyncio.Task | None


@dataclass(slots=True)
class ConnectedUser:
    id: str
    name: str
    role: str
    color: str
    websocket: SupportsSend
    limiter: RateLimiter
    strokes: dict[str, dict[str, Any]] = field(default_factory=dict)
    workspace_id: str = DEFAULT_WORKSPACE_ID
    state_version: int = 0
    workspace_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pending_move: PendingMove | None = None

    def public(self) -> dict[str, str]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "color": self.color,
        }


class Room:
    """A single lesson room with connected users and finished objects."""

    def __init__(
        self,
        room_id: str,
        objects: list[dict[str, Any]] | None = None,
        seq: int = 0,
        workspaces: list[dict[str, Any]] | None = None,
    ) -> None:
        self.id = room_id
        self.users: dict[str, ConnectedUser] = {}
        self.objects: list[dict[str, Any]] = list(objects or [])
        self.index: dict[str, dict[str, Any]] = {
            str(obj["id"]): obj for obj in self.objects if isinstance(obj, dict) and "id" in obj
        }
        self.seq = seq
        self.workspaces: dict[str, dict[str, Any]] = {
            workspace["id"]: workspace for workspace in normalize_workspaces(workspaces)
        }
        self.dirty = False
        self.last_active = time.monotonic()
        self.save_task: asyncio.Task[None] | None = None
        self.pubsub_task: asyncio.Task[None] | None = None
        self.heartbeat_task: asyncio.Task[None] | None = None
        self.pubsub: Any = None

    def touch(self) -> None:
        self.last_active = time.monotonic()

    def add_object(self, obj: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        obj["seq"] = self.seq
        self.objects.append(obj)
        self.index[str(obj["id"])] = obj
        return obj

    def get_object(self, object_id: str) -> dict[str, Any] | None:
        return self.index.get(object_id)

    def remove_object(self, object_id: str) -> dict[str, Any] | None:
        obj = self.index.pop(object_id, None)
        if obj is None:
            return None
        with suppress(ValueError):
            self.objects.remove(obj)
        return obj

    def clear(self) -> None:
        self.objects.clear()
        self.index.clear()

    # --------------------------------------------------------------- workspaces

    def workspace_list(self) -> list[dict[str, Any]]:
        """Return workspaces as a position-sorted copy of their dicts."""
        ordered = sorted(self.workspaces.values(), key=lambda workspace: workspace["position"])
        return [dict(workspace) for workspace in ordered]

    def workspace_ids(self) -> list[str]:
        return [workspace["id"] for workspace in self.workspace_list()]

    def get_workspace(self, workspace_id: str) -> dict[str, Any] | None:
        return self.workspaces.get(workspace_id)

    def add_workspace(self, name: str) -> dict[str, Any]:
        position = (
            max((workspace["position"] for workspace in self.workspaces.values()), default=-1) + 1
        )
        workspace = {"id": new_workspace_id(), "name": name, "position": position}
        self.workspaces[workspace["id"]] = workspace
        return workspace

    def rename_workspace(self, workspace_id: str, name: str) -> dict[str, Any] | None:
        workspace = self.workspaces.get(workspace_id)
        if workspace is None:
            return None
        workspace["name"] = name
        return workspace

    def delete_workspace(self, workspace_id: str) -> tuple[dict[str, Any] | None, str | None]:
        workspace = self.workspaces.get(workspace_id)
        if workspace is None or len(self.workspaces) <= 1:
            return None, None
        removed = self.workspaces.pop(workspace_id)
        self.clear_workspace(workspace_id)
        for position, remaining_id in enumerate(self.workspace_ids()):
            self.workspaces[remaining_id]["position"] = position
        remaining = self.workspace_ids()
        return removed, remaining[0] if remaining else None

    def reorder_workspaces(self, ids: list[str]) -> bool:
        if len(ids) != len(set(ids)) or set(ids) != set(self.workspaces):
            return False
        for position, workspace_id in enumerate(ids):
            self.workspaces[workspace_id]["position"] = position
        return True

    def objects_in(self, workspace_id: str) -> list[dict[str, Any]]:
        return [obj for obj in self.objects if obj.get("workspaceId") == workspace_id]

    def clear_workspace(self, workspace_id: str) -> None:
        for obj in self.objects_in(workspace_id):
            self.index.pop(str(obj["id"]), None)
        self.objects = [obj for obj in self.objects if obj.get("workspaceId") != workspace_id]


class RoomManager:
    def __init__(
        self,
        settings: Settings,
        store: SnapshotStore,
        images: ImageStorage | None = None,
        redis_client: Any | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.images = images or LocalImageStorage(settings.uploads_dir)
        self.rooms: dict[str, Room] = {}
        self._create_lock = asyncio.Lock()
        self.instance_id = uuid.uuid4().hex
        self._redis = redis_client
        self._owns_redis = redis_client is None

    # ---------------------------------------------------------------- lifecycle

    async def startup(self) -> None:
        deleted = await self.store.delete_older_than(self.settings.room_ttl_days)
        if deleted:
            logger.info("Removed %s expired room snapshots", deleted)
        if self.settings.redis_url and self._redis is None:
            try:
                import redis.asyncio as redis_async

                client = redis_async.from_url(self.settings.redis_url, decode_responses=True)
                await client.ping()
                self._redis = client
                logger.info("Redis room sharing enabled")
            except Exception:  # noqa: BLE001 - Redis is optional, fall back to memory
                logger.exception("Redis is unavailable, falling back to in-memory rooms")
                self._redis = None

    async def shutdown(self) -> None:
        rooms = list(self.rooms.values())
        self.rooms.clear()
        for room in rooms:
            await self._stop_room_tasks(room)
            await self.save_room(room, force=True)
        if self._owns_redis and self._redis is not None:
            with suppress(Exception):
                await self._redis.aclose()
            self._redis = None

    async def get_or_create(self, room_id: str) -> Room:
        room = self.rooms.get(room_id)
        if room is not None:
            return room
        async with self._create_lock:
            room = self.rooms.get(room_id)
            if room is not None:
                return room
            snapshot = await self.store.load(room_id)
            room = Room(room_id)
            if snapshot is not None:
                restored = [
                    obj
                    for obj in snapshot.objects
                    if isinstance(obj, dict) and isinstance(obj.get("id"), str)
                ]
                room.objects = restored
                room.index = {str(obj["id"]): obj for obj in restored}
                room.seq = snapshot.seq
                room.workspaces = {
                    workspace["id"]: workspace
                    for workspace in normalize_workspaces(snapshot.workspaces)
                }
                assign_orphan_objects(room.workspace_list(), room.objects)
                logger.info("Restored room %s with %s objects", room_id, len(restored))
            if self._redis is not None and not await self._restore_redis_state(room):
                await self._seed_redis_state(room)
            self.rooms[room_id] = room
            if self._redis is not None:
                await self._start_room_tasks(room)
            return room

    async def join(self, room_id: str, user: ConnectedUser) -> Room:
        room = await self.get_or_create(room_id)
        previous = room.users.pop(user.id, None)
        if previous is not None:
            await self._close_quietly(previous.websocket, 4409, "session_replaced")
        room.users[user.id] = user
        room.touch()
        if self._redis is not None:
            await self._set_presence(room_id, user)
        return room

    async def leave(self, room_id: str, user_id: str, *, notify: bool = True) -> None:
        room = self.rooms.get(room_id)
        if room is None:
            return
        await self._remove_presence(room_id, user_id)
        await self._remove_users(room, [user_id], notify=notify)

    async def list_users(self, room: Room) -> list[dict[str, str]]:
        """Merge locally connected users with fresh Redis presence entries."""

        users: dict[str, dict[str, str]] = {user.id: user.public() for user in room.users.values()}
        if self._redis is None:
            return list(users.values())
        raw = await self._redis.hgetall(self._presence_key(room.id))
        now = time.time()
        stale: list[str] = []
        for user_id, value in raw.items():
            if user_id in users:
                continue
            try:
                payload = json.loads(value)
                if now - float(payload["ts"]) > self.settings.presence_ttl_seconds:
                    stale.append(user_id)
                    continue
                users[user_id] = payload["user"]
            except (KeyError, TypeError, ValueError):
                stale.append(user_id)
        if stale:
            with suppress(Exception):
                await self._redis.hdel(self._presence_key(room.id), *stale)
        return list(users.values())

    async def kick(self, room_id: str, target_id: str, *, reason: str | None = None) -> bool:
        room = self.rooms.get(room_id)
        if self._redis is not None:
            if room is None:
                if not await self._presence_has(room_id, target_id):
                    return False
                await self._publish(
                    room_id,
                    {
                        "event": {
                            "type": "remote_kick",
                            "target": target_id,
                            "reason": reason,
                        }
                    },
                )
                return True
            if target_id not in room.users and not await self._presence_has(room_id, target_id):
                return False
            await self._publish(
                room_id,
                {
                    "event": {
                        "type": "remote_kick",
                        "target": target_id,
                        "reason": reason,
                    }
                },
            )
            await self._kick_local(room, target_id, reason=reason)
            return True
        if room is None or target_id not in room.users:
            return False
        return await self._kick_local(room, target_id, reason=reason)

    async def _kick_local(self, room: Room, target_id: str, *, reason: str | None = None) -> bool:
        user = room.users.get(target_id)
        if user is None:
            return False
        await self.send_to(
            user,
            {
                "type": "kicked",
                "reason": reason or "Учитель отключил вас от урока",
            },
        )
        await self._close_quietly(user.websocket, 4403, "kicked")
        await self._remove_users(room, [target_id], notify=True)
        return True

    async def close_room(self, room_id: str, *, notify_remote: bool = False) -> None:
        """Shut a room down locally and, optionally, on other instances."""
        if notify_remote and self._redis is not None:
            with suppress(Exception):
                await self._publish(room_id, {"event": {"type": "remote_room_closed"}})
        room = self.rooms.pop(room_id, None)
        if room is not None:
            for user in list(room.users.values()):
                await self.send_to(user, {"type": "kicked", "reason": "Комната удалена"})
                await self._close_quietly(user.websocket, 4403, "kicked")
            room.users.clear()
            await self._stop_room_tasks(room)
        await self._delete_room_keys(room_id)

    async def _delete_room_keys(self, room_id: str) -> None:
        if self._redis is None:
            return
        keys = [
            self._objects_key(room_id),
            self._workspaces_key(room_id),
            self._seq_key(room_id),
            self._presence_key(room_id),
        ]
        with suppress(Exception):
            await self._redis.delete(*keys)

    # ------------------------------------------------------------------ sending

    async def send_to(self, user: ConnectedUser, message: dict[str, Any]) -> bool:
        try:
            await user.websocket.send_json(message)
            return True
        except Exception:  # noqa: BLE001 - any transport error means a dead client
            logger.info("Connection lost for user %s", user.id)
            return False

    async def broadcast(
        self,
        room: Room,
        message: dict[str, Any],
        *,
        exclude: str | None = None,
        workspace_id: str | None = None,
    ) -> None:
        await self._send_local(room, message, exclude=exclude, workspace_id=workspace_id)
        if self._redis is not None:
            try:
                await self._sync_redis_event(room, message, workspace_id=workspace_id)
                await self._publish(room.id, {"event": message, "exclude": exclude})
            except Exception:  # noqa: BLE001 - Redis must not break local lessons
                logger.exception("Failed to publish %s for room %s", message.get("type"), room.id)

    async def _send_local(
        self,
        room: Room,
        message: dict[str, Any],
        *,
        exclude: str | None = None,
        workspace_id: str | None = None,
    ) -> None:
        dead: list[str] = []
        for user in list(room.users.values()):
            if user.id == exclude:
                continue
            if workspace_id is not None and user.workspace_id != workspace_id:
                continue
            if not await self.send_to(user, message):
                dead.append(user.id)
        if dead:
            await self._remove_users(room, dead, notify=True)

    async def _remove_users(self, room: Room, user_ids: list[str], *, notify: bool) -> None:
        removed: list[str] = []
        for user_id in user_ids:
            user = room.users.pop(user_id, None)
            if user is None:
                continue
            if user.pending_move is not None:
                await self._cancel_task(user.pending_move.task)
                user.pending_move = None
            await self._remove_presence(room.id, user_id)
            await self._finalize_strokes(room, user)
            removed.append(user_id)
        room.touch()
        if notify and removed:
            for user_id in removed:
                message = {"type": "user_left", "id": user_id}
                await self._send_local(room, message)
                if self._redis is not None:
                    with suppress(Exception):
                        await self._publish(room.id, {"event": message})
        if not room.users and self.rooms.get(room.id) is room:
            await self._persist_and_drop(room)

    async def _finalize_strokes(self, room: Room, user: ConnectedUser) -> None:
        strokes = list(user.strokes.values())
        user.strokes.clear()
        for obj in strokes:
            if not obj.get("points"):
                continue
            if len(room.objects) >= self.settings.max_objects_per_room:
                break
            workspace_id = obj.get("workspaceId") or room.workspace_ids()[0]
            self.add_object(room, obj, workspace_id)
            await self.broadcast(
                room,
                {
                    "type": "stroke_end",
                    "id": user.id,
                    "object": obj,
                    "workspaceId": workspace_id,
                },
                workspace_id=workspace_id,
            )

    @staticmethod
    async def _close_quietly(websocket: SupportsSend, code: int, reason: str) -> None:
        with suppress(Exception):
            await websocket.close(code=code, reason=reason)

    # ---------------------------------------------------------------- room state

    def add_object(
        self, room: Room, obj: dict[str, Any], workspace_id: str | None = None
    ) -> dict[str, Any]:
        if workspace_id is None:
            workspace_id = room.workspace_ids()[0]
        obj["workspaceId"] = workspace_id
        room.add_object(obj)
        self.mark_dirty(room)
        return obj

    def update_object(
        self, room: Room, object_id: str, x: float, y: float
    ) -> dict[str, Any] | None:
        return self.update_object_fields(room, object_id, x=x, y=y)

    def update_object_fields(
        self, room: Room, object_id: str, **fields: Any
    ) -> dict[str, Any] | None:
        obj = room.get_object(object_id)
        if obj is None:
            return None
        obj.update(fields)
        self.mark_dirty(room)
        return obj

    def delete_object(self, room: Room, object_id: str) -> dict[str, Any] | None:
        obj = room.remove_object(object_id)
        if obj is not None:
            self.mark_dirty(room)
        return obj

    def clear_room(self, room: Room, workspace_id: str | None = None) -> None:
        if workspace_id is None:
            workspace_id = room.workspace_ids()[0]
        room.clear_workspace(workspace_id)
        self.mark_dirty(room)

    def objects_for(self, room: Room, workspace_id: str) -> list[dict[str, Any]]:
        return room.objects_in(workspace_id)

    def create_workspace(self, room: Room, name: str | None = None) -> dict[str, Any]:
        if name is None:
            name = next_workspace_name(room.workspace_list())
        workspace = room.add_workspace(name)
        self.mark_dirty(room)
        return workspace

    def rename_workspace(self, room: Room, workspace_id: str, name: str) -> dict[str, Any] | None:
        workspace = room.rename_workspace(workspace_id, name)
        if workspace is not None:
            self.mark_dirty(room)
        return workspace

    def delete_workspace(
        self, room: Room, workspace_id: str
    ) -> tuple[dict[str, Any] | None, str | None]:
        for user in list(room.users.values()):
            for stroke_id in [
                sid
                for sid, stroke in user.strokes.items()
                if stroke.get("workspaceId") == workspace_id
            ]:
                user.strokes.pop(stroke_id, None)
        deleted, fallback = room.delete_workspace(workspace_id)
        if deleted is not None:
            self.mark_dirty(room)
        return deleted, fallback

    def reorder_workspaces(self, room: Room, ids: list[str]) -> bool:
        if not room.reorder_workspaces(ids):
            return False
        self.mark_dirty(room)
        return True

    async def switch_workspace(
        self,
        room: Room,
        user: ConnectedUser,
        workspace_id: str,
        *,
        reason: str = "switch",
        by: str | None = None,
    ) -> bool:
        if room.get_workspace(workspace_id) is None:
            return False
        async with user.workspace_lock:
            old_id = user.workspace_id
            if old_id == workspace_id:
                user.state_version += 1
                await self.send_to(
                    user,
                    {
                        "type": "workspace_state",
                        "workspaceId": workspace_id,
                        "objects": self.objects_for(room, workspace_id),
                        "stateVersion": user.state_version,
                    },
                )
                return True
            await self.broadcast(
                room,
                {"type": "cursor_remove", "id": user.id, "workspaceId": old_id},
                workspace_id=old_id,
            )
            await self._finalize_strokes(room, user)
            user.workspace_id = workspace_id
            user.state_version += 1
            if reason == "pull":
                moved = room.get_workspace(workspace_id)
                await self.send_to(
                    user,
                    {
                        "type": "workspace_moved",
                        "workspaceId": workspace_id,
                        "name": moved["name"] if moved is not None else "",
                        "by": by,
                    },
                )
            await self.send_to(
                user,
                {
                    "type": "workspace_state",
                    "workspaceId": workspace_id,
                    "objects": self.objects_for(room, workspace_id),
                    "stateVersion": user.state_version,
                },
            )
        return True

    async def prepare_move(
        self, room: Room, user: ConnectedUser, workspace_id: str, by: str | None
    ) -> str:
        """Send ``workspace_prepare_move`` and start the ack timeout. Returns the request id."""
        workspace = room.get_workspace(workspace_id)
        if workspace is None:
            return ""
        previous = user.pending_move
        if previous is not None:
            await self._cancel_task(previous.task)
        request_id = f"mv_{uuid.uuid4().hex}"
        task = asyncio.create_task(self._move_timeout(room, user, request_id))
        user.pending_move = PendingMove(request_id, workspace_id, by, task)
        await self.send_to(
            user,
            {
                "type": "workspace_prepare_move",
                "requestId": request_id,
                "workspaceId": workspace_id,
                "name": workspace["name"],
                "by": by,
            },
        )
        return request_id

    async def _move_timeout(self, room: Room, user: ConnectedUser, request_id: str) -> None:
        await asyncio.sleep(self.settings.workspace_move_timeout_seconds)
        await self._complete_move(room, user, request_id)

    async def handle_move_ack(self, room: Room, user: ConnectedUser, request_id: str) -> bool:
        """Complete a pending move on the student's ack. Returns False for stale/wrong acks."""
        pending = user.pending_move
        if pending is None or pending.request_id != request_id:
            return False
        await self._cancel_task(pending.task)
        return await self._complete_move(room, user, request_id)

    async def _complete_move(
        self, room: Room, user: ConnectedUser, expected_request_id: str
    ) -> bool:
        """Atomically clear the pending move and apply it if the request still matches."""
        pending = user.pending_move
        if pending is None or pending.request_id != expected_request_id:
            return False
        user.pending_move = None
        await self.switch_workspace(room, user, pending.workspace_id, reason="pull", by=pending.by)
        return True

    async def pull_users(
        self, room: Room, teacher: ConnectedUser, *, client_ids: list[str], all: bool
    ) -> int:
        """Prepare a move for the selected students across instances.

        Uses the merged roster (local users + Redis presence). Local students receive
        ``prepare_move``; remote students are targeted via a published
        ``remote_workspace_pull`` event. Returns the number of valid merged targets
        (``0`` means the WS layer should send ``user_not_found``).
        """
        workspace_id = teacher.workspace_id
        if room.get_workspace(workspace_id) is None:
            return 0
        roster = await self.list_users(room)
        local: list[ConnectedUser] = []
        remote_ids: list[str] = []
        for entry in roster:
            user_id = entry.get("id")
            if entry.get("role") != "student" or user_id == teacher.id:
                continue
            if not (all or user_id in client_ids):
                continue
            user = room.users.get(user_id)
            if user is not None:
                local.append(user)
            else:
                remote_ids.append(user_id)
        for user in local:
            await self.prepare_move(room, user, workspace_id, by=teacher.id)
        if self._redis is not None and remote_ids:
            payload: dict[str, Any] = {"workspaceId": workspace_id, "by": teacher.id}
            if all:
                payload["all"] = True
            else:
                payload["clientIds"] = remote_ids
            await self._publish(room.id, {"event": {"type": "remote_workspace_pull", **payload}})
        return len(local) + len(remote_ids)

    async def move_users_from_deleted(self, room: Room, deleted_id: str, fallback_id: str) -> None:
        for user in list(room.users.values()):
            if user.workspace_id == deleted_id:
                await self.switch_workspace(room, user, fallback_id, reason="delete")

    def has_capacity(self, room: Room) -> bool:
        return len(room.objects) < self.settings.max_objects_per_room

    # ------------------------------------------------------------- persistence

    def mark_dirty(self, room: Room) -> None:
        room.touch()
        room.dirty = True
        task = room.save_task
        if task is None or task.done():
            room.save_task = asyncio.create_task(self._save_loop(room))

    async def _save_loop(self, room: Room) -> None:
        try:
            while room.dirty:
                await asyncio.sleep(self.settings.snapshot_interval_seconds)
                if room.dirty:
                    await self.save_room(room)
        except asyncio.CancelledError:
            raise
        finally:
            if room.save_task is asyncio.current_task():
                room.save_task = None

    async def save_room(self, room: Room, *, force: bool = False) -> None:
        if not force and not room.dirty:
            return
        room.dirty = False
        objects = list(room.objects)
        seq = room.seq
        workspaces = room.workspace_list()
        try:
            await self.store.save(room.id, objects, seq, workspaces)
        except Exception:  # noqa: BLE001 - persistence must not crash the room
            logger.exception("Failed to save snapshot for room %s", room.id)
            room.dirty = True

    async def _persist_and_drop(self, room: Room) -> None:
        await self._stop_room_tasks(room)
        await self.save_room(room, force=True)
        if self.rooms.get(room.id) is room:
            self.rooms.pop(room.id, None)
        logger.info("Room %s is empty and went to sleep", room.id)

    async def _stop_room_tasks(self, room: Room) -> None:
        for task in (room.save_task, room.pubsub_task, room.heartbeat_task):
            await self._cancel_task(task)
        room.save_task = None
        room.pubsub_task = None
        room.heartbeat_task = None
        if room.pubsub is not None:
            with suppress(Exception):
                await room.pubsub.unsubscribe(self._channel(room.id))
                await room.pubsub.aclose()
            room.pubsub = None

    @staticmethod
    async def _cancel_task(task: asyncio.Task[None] | None) -> None:
        if task is None or task.done() or task is asyncio.current_task():
            return
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    # ---------------------------------------------------------------- redis glue

    def _key(self, room_id: str, suffix: str) -> str:
        return f"{self.settings.redis_prefix}:room:{room_id}:{suffix}"

    def _channel(self, room_id: str) -> str:
        return f"{self.settings.redis_prefix}:room:{room_id}:events"

    def _objects_key(self, room_id: str) -> str:
        return self._key(room_id, "objects")

    def _workspaces_key(self, room_id: str) -> str:
        return self._key(room_id, "workspaces")

    def _seq_key(self, room_id: str) -> str:
        return self._key(room_id, "seq")

    def _presence_key(self, room_id: str) -> str:
        return self._key(room_id, "presence")

    async def _restore_redis_state(self, room: Room) -> bool:
        """Restore room state from Redis when it is authoritative.

        Returns ``False`` when Redis holds no state for the room (all of
        ``workspaces``, ``objects`` and ``seq`` are absent); the caller then keeps the
        SQLite snapshot and seeds Redis from it. Otherwise Redis wins: metadata, objects
        and ``seq`` are loaded, normalized, orphaned objects repaired, and the repaired
        state written back.
        """
        raw_workspaces = await self._redis.hgetall(self._workspaces_key(room.id))
        raw_objects = await self._redis.hgetall(self._objects_key(room.id))
        seq = await self._redis.get(self._seq_key(room.id))
        if not raw_workspaces and not raw_objects and seq is None:
            return False

        workspaces: list[dict[str, Any]] = []
        for value in raw_workspaces.values():
            try:
                workspace = json.loads(value)
            except (TypeError, ValueError):
                continue
            if isinstance(workspace, dict):
                workspaces.append(workspace)
        normalized = normalize_workspaces(workspaces)
        room.workspaces = {workspace["id"]: workspace for workspace in normalized}

        objects: list[dict[str, Any]] = []
        for value in raw_objects.values():
            try:
                obj = json.loads(value)
            except (TypeError, ValueError):
                continue
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                objects.append(obj)
        room.objects = objects
        room.index = {str(obj["id"]): obj for obj in objects}
        room.seq = int(seq or 0)

        assign_orphan_objects(room.workspace_list(), room.objects)
        await self._seed_redis_state(room)
        logger.info("Loaded room %s from Redis with %s objects", room.id, len(objects))
        return True

    async def _seed_redis_state(self, room: Room) -> None:
        """Write the room's workspaces, objects and seq to Redis in one startup path."""
        await self._write_workspaces(room)
        await self._write_objects(room)
        await self._redis.set(self._seq_key(room.id), room.seq)

    async def _write_workspaces(self, room: Room) -> None:
        mapping = {
            workspace["id"]: json.dumps(workspace, ensure_ascii=False)
            for workspace in room.workspace_list()
        }
        if mapping:
            await self._redis.hset(self._workspaces_key(room.id), mapping=mapping)

    async def _write_objects(self, room: Room) -> None:
        mapping = {str(obj["id"]): json.dumps(obj, ensure_ascii=False) for obj in room.objects}
        if mapping:
            await self._redis.hset(self._objects_key(room.id), mapping=mapping)

    async def _delete_workspace_objects(self, room_id: str, workspace_id: str) -> None:
        objects_key = self._objects_key(room_id)
        raw = await self._redis.hgetall(objects_key)
        fields = [
            field for field, value in raw.items() if _redis_object_workspace(value) == workspace_id
        ]
        if fields:
            await self._redis.hdel(objects_key, *fields)

    async def purge_room_keys(self) -> int:
        """Delete every Redis key of a room; used by the accounts migration."""
        if self._redis is None:
            return 0
        pattern = f"{self.settings.redis_prefix}:room:*"
        keys = [key async for key in self._redis.scan_iter(match=pattern)]
        if keys:
            await self._redis.delete(*keys)
        return len(keys)

    async def _start_room_tasks(self, room: Room) -> None:
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(self._channel(room.id))
        room.pubsub = pubsub
        room.pubsub_task = asyncio.create_task(self._listen(room.id, pubsub))
        room.heartbeat_task = asyncio.create_task(self._heartbeat_loop(room))

    async def _listen(self, room_id: str, pubsub: Any) -> None:
        try:
            async for item in pubsub.listen():
                if item.get("type") != "message":
                    continue
                try:
                    envelope = json.loads(item["data"])
                except (TypeError, ValueError):
                    continue
                if envelope.get("origin") == self.instance_id:
                    continue
                room = self.rooms.get(room_id)
                if room is None:
                    break
                event = envelope.get("event")
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "remote_kick":
                    await self._kick_local(
                        room, str(event.get("target", "")), reason=event.get("reason")
                    )
                    continue
                if event.get("type") == "remote_workspace_pull":
                    await self._handle_remote_pull(room, event)
                    continue
                if event.get("type") == "remote_room_closed":
                    await self.close_room(room_id)
                    return
                await self._apply_remote_event(room, event)
                scope = (
                    event.get("workspaceId")
                    if event.get("type") in WORKSPACE_SCOPED_EVENTS
                    else None
                )
                await self._send_local(
                    room, event, exclude=envelope.get("exclude"), workspace_id=scope
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a broken subscriber must not kill the app
            logger.exception("Redis subscriber failed for room %s", room_id)

    async def _handle_remote_pull(self, room: Room, event: dict[str, Any]) -> None:
        """Prepare a move for local students targeted by another instance's pull."""
        workspace_id = event.get("workspaceId")
        if not isinstance(workspace_id, str) or room.get_workspace(workspace_id) is None:
            return
        by = event.get("by")
        pull_all = event.get("all") is True
        client_ids = event.get("clientIds")
        requested = set(client_ids) if isinstance(client_ids, list) else set()
        for user in list(room.users.values()):
            if user.role != "student":
                continue
            if pull_all or user.id in requested:
                await self.prepare_move(room, user, workspace_id, by=by)

    async def _heartbeat_loop(self, room: Room) -> None:
        try:
            while True:
                await asyncio.sleep(self.settings.heartbeat_seconds)
                mapping = {
                    user.id: self._presence_payload(user) for user in list(room.users.values())
                }
                if mapping and self._redis is not None:
                    await self._redis.hset(self._presence_key(room.id), mapping=mapping)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - heartbeat is best effort
            logger.exception("Presence heartbeat failed for room %s", room.id)

    def _presence_payload(self, user: ConnectedUser) -> str:
        return json.dumps({"user": user.public(), "ts": time.time()}, ensure_ascii=False)

    async def _set_presence(self, room_id: str, user: ConnectedUser) -> None:
        await self._redis.hset(self._presence_key(room_id), user.id, self._presence_payload(user))

    async def _remove_presence(self, room_id: str, user_id: str) -> None:
        if self._redis is None:
            return
        with suppress(Exception):
            await self._redis.hdel(self._presence_key(room_id), user_id)

    async def _presence_has(self, room_id: str, user_id: str) -> bool:
        value = await self._redis.hget(self._presence_key(room_id), user_id)
        if not value:
            return False
        try:
            payload = json.loads(value)
            return time.time() - float(payload["ts"]) <= self.settings.presence_ttl_seconds
        except (KeyError, TypeError, ValueError):
            return False

    async def check_redis(self) -> bool | None:
        """None means Redis is not configured (single-instance mode)."""

        if self._redis is None:
            return None
        try:
            return bool(await self._redis.ping())
        except Exception:  # noqa: BLE001 - readiness reports the failure
            logger.exception("Redis readiness check failed")
            return False

    async def _publish(self, room_id: str, payload: dict[str, Any]) -> None:
        envelope = {"origin": self.instance_id, **payload}
        await self._redis.publish(self._channel(room_id), json.dumps(envelope, ensure_ascii=False))

    async def _sync_redis_event(
        self, room: Room, message: dict[str, Any], *, workspace_id: str | None = None
    ) -> None:
        kind = message.get("type")
        objects_key = self._objects_key(room.id)
        if kind in ADD_EVENTS:
            obj = message.get("object")
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                await self._redis.hset(
                    objects_key, str(obj["id"]), json.dumps(obj, ensure_ascii=False)
                )
                await self._redis.set(self._seq_key(room.id), room.seq)
        elif kind == "object_update":
            obj = room.get_object(str(message.get("objectId", "")))
            if obj is not None:
                await self._redis.hset(
                    objects_key, str(obj["id"]), json.dumps(obj, ensure_ascii=False)
                )
        elif kind in OBJECT_EVENTS:
            obj = message.get("object")
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                await self._redis.hset(
                    objects_key, str(obj["id"]), json.dumps(obj, ensure_ascii=False)
                )
        elif kind == "object_delete":
            await self._redis.hdel(objects_key, str(message.get("objectId", "")))
        elif kind == "clear":
            target = workspace_id or message.get("workspaceId")
            if isinstance(target, str):
                await self._delete_workspace_objects(room.id, target)
            else:
                await self._redis.delete(objects_key)
            await self._redis.set(self._seq_key(room.id), room.seq)
        elif kind in ("workspace_created", "workspace_renamed", "workspace_reordered"):
            await self._write_workspaces(room)
        elif kind == "workspace_deleted":
            deleted = message.get("workspaceId")
            if isinstance(deleted, str):
                await self._redis.hdel(self._workspaces_key(room.id), deleted)
                await self._delete_workspace_objects(room.id, deleted)

    async def _apply_remote_event(self, room: Room, message: dict[str, Any]) -> None:
        """Update local room state from an event produced by another instance."""

        kind = message.get("type")
        changed = False
        if kind in ADD_EVENTS:
            obj = message.get("object")
            if (
                isinstance(obj, dict)
                and isinstance(obj.get("id"), str)
                and room.get_object(str(obj["id"])) is None
            ):
                room.objects.append(obj)
                room.index[str(obj["id"])] = obj
                room.seq = max(room.seq, int(obj.get("seq", 0) or 0))
                changed = True
        elif kind in OBJECT_EVENTS:
            obj = message.get("object")
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                existing = room.get_object(str(obj["id"]))
                if existing is None:
                    room.objects.append(obj)
                    room.index[str(obj["id"])] = obj
                    room.seq = max(room.seq, int(obj.get("seq", 0) or 0))
                else:
                    existing.update(obj)
                changed = True
        elif kind == "object_update":
            obj = room.get_object(str(message.get("objectId", "")))
            if obj is not None:
                obj["x"] = message.get("x", obj.get("x"))
                obj["y"] = message.get("y", obj.get("y"))
                changed = True
        elif kind == "object_delete":
            changed = room.remove_object(str(message.get("objectId", ""))) is not None
        elif kind == "clear":
            workspace_id = message.get("workspaceId")
            if isinstance(workspace_id, str):
                room.clear_workspace(workspace_id)
            else:
                room.clear()
            changed = True
        elif kind == "workspace_created":
            workspace = message.get("workspace")
            if isinstance(workspace, dict) and isinstance(workspace.get("id"), str):
                merged = list(room.workspaces.values()) + [workspace]
                room.workspaces = {ws["id"]: ws for ws in normalize_workspaces(merged)}
                changed = True
        elif kind == "workspace_renamed":
            workspace_id = message.get("workspaceId")
            name = message.get("name")
            existing = room.workspaces.get(workspace_id) if isinstance(workspace_id, str) else None
            if existing is not None and isinstance(name, str):
                existing["name"] = name
                changed = True
        elif kind == "workspace_reordered":
            ids = message.get("workspaceIds")
            if isinstance(ids, list):
                changed = room.reorder_workspaces(
                    [workspace_id for workspace_id in ids if isinstance(workspace_id, str)]
                )
        elif kind == "workspace_deleted":
            deleted_id = message.get("workspaceId")
            if isinstance(deleted_id, str) and deleted_id in room.workspaces:
                room.workspaces.pop(deleted_id, None)
                room.clear_workspace(deleted_id)
                fallback = message.get("fallbackId")
                remaining = room.workspace_ids()
                if not isinstance(fallback, str) or fallback not in room.workspaces:
                    fallback = remaining[0] if remaining else None
                for position, remaining_id in enumerate(remaining):
                    room.workspaces[remaining_id]["position"] = position
                if fallback:
                    await self.move_users_from_deleted(room, deleted_id, fallback)
                changed = True
        if changed:
            self.mark_dirty(room)

    # -------------------------------------------------------------------- stats

    @property
    def room_count(self) -> int:
        return len(self.rooms)

    @property
    def user_count(self) -> int:
        return sum(len(room.users) for room in self.rooms.values())
