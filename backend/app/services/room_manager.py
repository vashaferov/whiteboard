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

logger = logging.getLogger(__name__)

ADD_EVENTS = {"shape_add", "text_add", "image_add", "stroke_end"}
OBJECT_EVENTS = {"object_transform", "text_update"}


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
class ConnectedUser:
    id: str
    name: str
    role: str
    color: str
    websocket: SupportsSend
    limiter: RateLimiter
    strokes: dict[str, dict[str, Any]] = field(default_factory=dict)

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
        self, room_id: str, objects: list[dict[str, Any]] | None = None, seq: int = 0
    ) -> None:
        self.id = room_id
        self.users: dict[str, ConnectedUser] = {}
        self.objects: list[dict[str, Any]] = list(objects or [])
        self.index: dict[str, dict[str, Any]] = {
            str(obj["id"]): obj for obj in self.objects if isinstance(obj, dict) and "id" in obj
        }
        self.seq = seq
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
                logger.info("Restored room %s with %s objects", room_id, len(restored))
            if self._redis is not None:
                await self._restore_redis_state(room)
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

    async def kick(self, room_id: str, target_id: str) -> bool:
        room = self.rooms.get(room_id)
        if room is None:
            return False
        if self._redis is not None:
            if target_id not in room.users and not await self._presence_has(room_id, target_id):
                return False
            await self._publish(room_id, {"event": {"type": "remote_kick", "target": target_id}})
            await self._kick_local(room, target_id)
            return True
        if target_id not in room.users:
            return False
        return await self._kick_local(room, target_id)

    async def _kick_local(self, room: Room, target_id: str) -> bool:
        user = room.users.get(target_id)
        if user is None:
            return False
        await self.send_to(user, {"type": "kicked", "reason": "Учитель отключил вас от урока"})
        await self._close_quietly(user.websocket, 4403, "kicked")
        await self._remove_users(room, [target_id], notify=True)
        return True

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
    ) -> None:
        await self._send_local(room, message, exclude=exclude)
        if self._redis is not None:
            try:
                await self._sync_redis_event(room, message)
                await self._publish(room.id, {"event": message, "exclude": exclude})
            except Exception:  # noqa: BLE001 - Redis must not break local lessons
                logger.exception("Failed to publish %s for room %s", message.get("type"), room.id)

    async def _send_local(
        self,
        room: Room,
        message: dict[str, Any],
        *,
        exclude: str | None = None,
    ) -> None:
        dead: list[str] = []
        for user in list(room.users.values()):
            if user.id == exclude:
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
            self.add_object(room, obj)
            await self.broadcast(room, {"type": "stroke_end", "id": user.id, "object": obj})

    @staticmethod
    async def _close_quietly(websocket: SupportsSend, code: int, reason: str) -> None:
        with suppress(Exception):
            await websocket.close(code=code, reason=reason)

    # ---------------------------------------------------------------- room state

    def add_object(self, room: Room, obj: dict[str, Any]) -> dict[str, Any]:
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

    def clear_room(self, room: Room) -> None:
        room.clear()
        self.mark_dirty(room)

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
        try:
            await self.store.save(room.id, objects, seq, [])
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

    def _seq_key(self, room_id: str) -> str:
        return self._key(room_id, "seq")

    def _presence_key(self, room_id: str) -> str:
        return self._key(room_id, "presence")

    async def _restore_redis_state(self, room: Room) -> None:
        raw = await self._redis.hgetall(self._objects_key(room.id))
        seq = await self._redis.get(self._seq_key(room.id))
        if not raw and seq is None:
            return
        objects: list[dict[str, Any]] = []
        for value in raw.values():
            try:
                obj = json.loads(value)
            except (TypeError, ValueError):
                continue
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                objects.append(obj)
        room.objects = objects
        room.index = {str(obj["id"]): obj for obj in objects}
        room.seq = int(seq or 0)
        logger.info("Loaded room %s from Redis with %s objects", room.id, len(objects))

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
                    await self._kick_local(room, str(event.get("target", "")))
                    continue
                self._apply_remote_event(room, event)
                await self._send_local(room, event, exclude=envelope.get("exclude"))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a broken subscriber must not kill the app
            logger.exception("Redis subscriber failed for room %s", room_id)

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

    async def _sync_redis_event(self, room: Room, message: dict[str, Any]) -> None:
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
            await self._redis.delete(objects_key)
            await self._redis.set(self._seq_key(room.id), room.seq)

    def _apply_remote_event(self, room: Room, message: dict[str, Any]) -> None:
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
            room.clear()
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
