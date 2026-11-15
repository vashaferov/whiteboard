"""Redis-backed room sharing: Pub/Sub, shared objects and presence."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from app.config import Settings
from app.services.room_manager import ConnectedUser, RateLimiter, RoomManager
from app.services.storage import SnapshotStore
from fakeredis import FakeAsyncRedis, FakeServer


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.close_code: int | None = None
        self.close_reason: str | None = None

    async def send_json(self, data: Any) -> None:
        self.messages.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.close_code = code
        self.close_reason = reason


def make_user(user_id: str, role: str = "student") -> tuple[ConnectedUser, FakeWebSocket]:
    websocket = FakeWebSocket()
    user = ConnectedUser(
        id=user_id,
        name=user_id,
        role=role,
        color="#2563eb",
        websocket=websocket,
        limiter=RateLimiter({"default": 1000}),
    )
    return user, websocket


async def wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition was not met in time")


async def wait_for_hash_field(client, key: str, field: str, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if await client.hget(key, field):
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"{field} was not written to {key}")


@pytest.fixture
async def redis_pair():
    server = FakeServer()
    first = FakeAsyncRedis(server=server, decode_responses=True)
    second = FakeAsyncRedis(server=server, decode_responses=True)
    yield first, second
    await first.aclose()
    await second.aclose()


def make_manager(
    settings: Settings, tmp_path, name: str, redis_client: FakeAsyncRedis
) -> RoomManager:
    store = SnapshotStore(tmp_path / f"{name}.db")
    return RoomManager(settings, store, redis_client=redis_client)


async def test_objects_and_presence_are_shared(settings: Settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    settings = settings.model_copy(update={"presence_ttl_seconds": 10, "heartbeat_seconds": 100})
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()

    user_a, _ = make_user("u-a")
    user_b, websocket_b = make_user("u-b")
    room_a = await manager_a.join("shared", user_a)
    room_b = await manager_b.join("shared", user_b)

    users_b = await manager_b.list_users(room_b)
    assert {user["id"] for user in users_b} == {"u-a", "u-b"}

    obj = {
        "id": "shape-1",
        "type": "shape",
        "shape": "rect",
        "author": "u-a",
        "x": 10,
        "y": 20,
        "width": 100,
        "height": 50,
        "color": "#2563eb",
        "fill": "#ffffff",
        "strokeWidth": 2,
    }
    manager_a.add_object(room_a, obj)
    await manager_a.broadcast(room_a, {"type": "shape_add", "id": "u-a", "object": obj})

    await wait_for(lambda: room_b.get_object("shape-1") is not None)
    assert websocket_b.messages[-1]["type"] == "shape_add"

    manager_a.update_object_fields(room_a, "shape-1", x=75, rotation=30)
    await manager_a.broadcast(
        room_a,
        {"type": "object_transform", "id": "u-a", "object": room_a.get_object("shape-1")},
    )
    await wait_for(lambda: room_b.get_object("shape-1")["x"] == 75)
    assert room_b.get_object("shape-1")["rotation"] == 30

    manager_a.delete_object(room_a, "shape-1")
    await manager_a.broadcast(room_a, {"type": "object_delete", "id": "u-a", "objectId": "shape-1"})
    await wait_for(lambda: room_b.get_object("shape-1") is None)

    # A fresh instance restores shared state straight from Redis.
    manager_c = make_manager(settings, tmp_path, "c", first_redis)
    await manager_c.startup()
    room_c = await manager_c.get_or_create("shared")
    assert room_c.objects == []

    manager_a.add_object(room_a, {**obj, "id": "shape-2"})
    await manager_a.broadcast(
        room_a, {"type": "shape_add", "id": "u-a", "object": room_a.get_object("shape-2")}
    )
    await wait_for_hash_field(first_redis, "whiteboard:room:shared:objects", "shape-2")

    # A brand-new instance reads the shared state straight from Redis.
    manager_d = make_manager(settings, tmp_path, "d", second_redis)
    await manager_d.startup()
    room_d = await manager_d.get_or_create("shared")
    assert room_d.get_object("shape-2") is not None

    await manager_a.shutdown()
    await manager_b.shutdown()
    await manager_c.shutdown()
    await manager_d.shutdown()


async def test_kick_crosses_instances(settings: Settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    settings = settings.model_copy(update={"presence_ttl_seconds": 10, "heartbeat_seconds": 100})
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()

    user_a, _ = make_user("u-a", "teacher")
    user_b, websocket_b = make_user("u-b")
    room_a = await manager_a.join("lesson", user_a)
    room_b = await manager_b.join("lesson", user_b)

    assert await manager_a.kick("lesson", "u-b") is True
    await wait_for(lambda: websocket_b.close_code == 4403)
    await wait_for(lambda: "u-b" not in room_b.users)
    assert websocket_b.messages[-1]["type"] == "kicked"
    assert await first_redis.hget("whiteboard:room:lesson:presence", "u-b") is None
    assert "u-b" not in {user["id"] for user in await manager_a.list_users(room_a)}

    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_presence_expires_without_heartbeat(settings: Settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    settings = settings.model_copy(update={"presence_ttl_seconds": 0.05, "heartbeat_seconds": 100})
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()

    user_a, _ = make_user("u-a")
    await manager_a.join("short", user_a)
    room_b = await manager_b.get_or_create("short")
    assert [user["id"] for user in await manager_b.list_users(room_b)] == ["u-a"]

    await asyncio.sleep(0.1)
    assert await manager_b.list_users(room_b) == []

    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_redis_unavailable_falls_back_to_memory(
    settings: Settings, tmp_path, monkeypatch
) -> None:
    settings = settings.model_copy(update={"redis_url": "redis://127.0.0.1:1/0"})

    def boom(*args, **kwargs):
        raise RuntimeError("no redis")

    monkeypatch.setattr("redis.asyncio.from_url", boom)
    manager = RoomManager(settings, SnapshotStore(tmp_path / "fallback.db"))
    await manager.startup()
    assert manager._redis is None

    user, _ = make_user("u-a")
    room = await manager.join("offline", user)
    assert room.users["u-a"] is user
    assert [user["id"] for user in await manager.list_users(room)] == ["u-a"]
    await manager.shutdown()
