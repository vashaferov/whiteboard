"""RoomManager.close_room: local and cross-instance shutdown."""

from __future__ import annotations

import asyncio
from typing import Any

from app.config import Settings
from app.services.room_manager import ConnectedUser, RateLimiter, RoomManager
from app.services.storage import SnapshotStore


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


def make_user(user_id: str = "u-a") -> tuple[ConnectedUser, FakeWebSocket]:
    websocket = FakeWebSocket()
    user = ConnectedUser(
        id=user_id,
        name=user_id,
        role="student",
        color="#2563eb",
        websocket=websocket,
        limiter=RateLimiter({"default": 1000}),
    )
    return user, websocket


def make_manager(settings: Settings, tmp_path, name: str, redis_client) -> RoomManager:
    return RoomManager(settings, SnapshotStore(tmp_path / f"{name}.db"), redis_client=redis_client)


async def wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition was not met in time")


async def test_close_room_kicks_and_clears_state(settings: Settings, tmp_path, redis_pair) -> None:
    redis_client, _ = redis_pair
    manager = make_manager(settings, tmp_path, "local", redis_client)
    user, websocket = make_user()
    await manager.join("r_1", user)
    await redis_client.hset("whiteboard:room:r_1:presence", mapping={"u-a": "{}"})
    await redis_client.hset("whiteboard:room:r_1:objects", mapping={"o": "{}"})

    await manager.close_room("r_1")

    assert manager.rooms.get("r_1") is None
    assert websocket.close_code == 4403
    assert any(
        message["type"] == "kicked" and "Комната удалена" in message["reason"]
        for message in websocket.messages
    )
    assert await redis_client.keys("whiteboard:room:r_1:*") == []
    await manager.shutdown()


async def test_close_room_is_idempotent(settings: Settings, tmp_path) -> None:
    manager = make_manager(settings, tmp_path, "idempotent", None)

    await manager.close_room("missing")
    await manager.close_room("missing")

    await manager.shutdown()


async def test_remote_room_closed_drops_local_copy(
    settings: Settings, tmp_path, redis_pair
) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    user, websocket = make_user("u-b")
    await manager_b.join("r_1", user)
    await asyncio.sleep(0.05)

    await manager_a.close_room("r_1", notify_remote=True)

    await wait_for(lambda: manager_b.rooms.get("r_1") is None)
    assert websocket.close_code == 4403
    assert any(message["type"] == "kicked" for message in websocket.messages)

    await manager_a.shutdown()
    await manager_b.shutdown()
