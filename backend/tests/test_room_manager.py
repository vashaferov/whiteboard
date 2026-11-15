"""Unit-тесты RoomManager и RateLimiter."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.config import Settings
from app.services.room_manager import ConnectedUser, RateLimiter, RoomManager
from app.services.storage import SnapshotStore

SAMPLE_OBJECT = {
    "id": "o1",
    "type": "shape",
    "shapeType": "rect",
    "author": "a",
    "x": 1,
    "y": 2,
    "width": 3,
    "height": 4,
}


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.closed: list[tuple[int, str | None]] = []

    async def send_json(self, data: dict) -> None:
        self.messages.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed.append((code, reason))


def make_user(
    user_id: str = "a", role: str = "teacher", websocket: FakeWebSocket | None = None
) -> tuple[ConnectedUser, FakeWebSocket]:
    socket = websocket or FakeWebSocket()
    user = ConnectedUser(
        id=user_id,
        name=user_id.upper(),
        role=role,
        color="#123456",
        websocket=socket,
        limiter=RateLimiter({}),
    )
    return user, socket


def build_manager(tmp_path: Path) -> tuple[Settings, SnapshotStore, RoomManager]:
    settings = Settings(
        jwt_secret="test-secret-0123456789abcdef0123456789",
        teacher_code="code",
        data_dir=tmp_path / "data",
        uploads_dir=tmp_path / "uploads",
        frontend_dir=tmp_path / "frontend",
        snapshot_interval_seconds=0.01,
    )
    store = SnapshotStore(tmp_path / "whiteboard.db")
    return settings, store, RoomManager(settings, store)


async def test_broadcast_excludes_sender(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    sender, sender_socket = make_user("a")
    receiver, receiver_socket = make_user("b", role="student")
    await manager.join("r1", sender)
    await manager.join("r1", receiver)

    await manager.broadcast(room, {"type": "ping"}, exclude="a")

    assert sender_socket.messages == []
    assert receiver_socket.messages == [{"type": "ping"}]
    await manager.shutdown()
    await store.close()


async def test_leave_notifies_others(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    teacher, teacher_socket = make_user("a")
    student, _ = make_user("b", role="student")
    await manager.join("r1", teacher)
    await manager.join("r1", student)

    await manager.leave("r1", "b")

    assert teacher_socket.messages[-1] == {"type": "user_left", "id": "b"}
    await manager.shutdown()
    await store.close()


async def test_empty_room_is_saved_and_dropped(tmp_path: Path) -> None:
    settings, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    user, _ = make_user("a")
    await manager.join("r1", user)
    manager.add_object(room, dict(SAMPLE_OBJECT))
    room.dirty = False  # избегаем фоновой задачи в этом тесте

    await manager.leave("r1", "a")
    assert "r1" not in manager.rooms

    snapshot = await store.load("r1")
    assert snapshot is not None
    assert [obj["id"] for obj in snapshot.objects] == ["o1"]

    manager2 = RoomManager(settings, store)
    restored = await manager2.get_or_create("r1")
    assert [obj["id"] for obj in restored.objects] == ["o1"]
    assert restored.get_object("o1") is not None
    await manager2.shutdown()
    await store.close()


async def test_dirty_room_is_saved_periodically(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    user, _ = make_user("a")
    await manager.join("r1", user)
    manager.add_object(room, dict(SAMPLE_OBJECT))

    await asyncio.sleep(0.1)

    snapshot = await store.load("r1")
    assert snapshot is not None
    assert [obj["id"] for obj in snapshot.objects] == ["o1"]
    await manager.shutdown()
    await store.close()


async def test_update_delete_and_clear(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    manager.add_object(room, dict(SAMPLE_OBJECT))

    updated = manager.update_object(room, "o1", 50, 60)
    assert updated is not None
    assert (updated["x"], updated["y"]) == (50, 60)

    assert manager.update_object(room, "missing", 0, 0) is None
    assert manager.delete_object(room, "o1") is not None
    assert room.get_object("o1") is None

    manager.add_object(room, dict(SAMPLE_OBJECT))
    manager.clear_room(room)
    assert room.objects == []
    assert room.get_object("o1") is None
    await manager.shutdown()
    await store.close()


async def test_kick_disconnects_and_notifies(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    teacher, teacher_socket = make_user("a")
    student, student_socket = make_user("b", role="student")
    await manager.join("r1", teacher)
    await manager.join("r1", student)
    teacher_socket.messages.clear()

    assert await manager.kick("r1", "b") is True

    assert student_socket.messages[0]["type"] == "kicked"
    assert student_socket.closed == [(4403, "kicked")]
    assert teacher_socket.messages[-1] == {"type": "user_left", "id": "b"}
    assert await manager.kick("r1", "b") is False
    await manager.shutdown()
    await store.close()


def test_rate_limiter_sliding_window() -> None:
    limiter = RateLimiter({"points": 2, "default": 3})
    assert limiter.allow("points") is True
    assert limiter.allow("points") is True
    assert limiter.allow("points") is False
    assert limiter.allow("cursor") is True
    assert limiter.allow("cursor") is True
    assert limiter.allow("cursor") is True
    assert limiter.allow("cursor") is False

    unlimited = RateLimiter({"default": 0})
    for _ in range(100):
        assert unlimited.allow("cursor") is True


def test_limiter_is_per_category() -> None:
    limiter = RateLimiter({"points": 1, "cursor": 1})
    assert limiter.allow("points") is True
    assert limiter.allow("cursor") is True
    assert limiter.allow("points") is False
    assert limiter.allow("cursor") is False
