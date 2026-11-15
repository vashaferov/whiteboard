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
    manager.add_object(room, dict(SAMPLE_OBJECT), "ws_default")
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
    manager.add_object(room, dict(SAMPLE_OBJECT), "ws_default")

    await asyncio.sleep(0.1)

    snapshot = await store.load("r1")
    assert snapshot is not None
    assert [obj["id"] for obj in snapshot.objects] == ["o1"]
    await manager.shutdown()
    await store.close()


async def test_update_delete_and_clear(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    manager.add_object(room, dict(SAMPLE_OBJECT), "ws_default")

    updated = manager.update_object(room, "o1", 50, 60)
    assert updated is not None
    assert (updated["x"], updated["y"]) == (50, 60)

    assert manager.update_object(room, "missing", 0, 0) is None
    assert manager.delete_object(room, "o1") is not None
    assert room.get_object("o1") is None

    manager.add_object(room, dict(SAMPLE_OBJECT), "ws_default")
    manager.clear_room(room, "ws_default")
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


def set_workspace(user: ConnectedUser, workspace_id: str) -> None:
    user.workspace_id = workspace_id


async def test_new_room_has_default_workspace(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    assert room.workspace_ids() == ["ws_default"]
    assert room.workspace_list()[0]["name"] == "Страница 1"
    await manager.shutdown()
    await store.close()


async def test_workspace_crud_and_positions(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Черновик")
    assert room.workspace_ids() == ["ws_default", second["id"]]
    assert manager.rename_workspace(room, second["id"], "Идеи")["name"] == "Идеи"
    assert manager.reorder_workspaces(room, [second["id"], "ws_default"]) is True
    assert room.workspace_ids() == [second["id"], "ws_default"]
    assert manager.reorder_workspaces(room, ["ws_default"]) is False
    deleted, fallback = manager.delete_workspace(room, second["id"])
    assert deleted["id"] == second["id"]
    assert fallback == "ws_default"
    assert manager.delete_workspace(room, "ws_default") == (None, None)
    await manager.shutdown()
    await store.close()


async def test_objects_and_clear_are_scoped(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    manager.add_object(room, dict(SAMPLE_OBJECT), "ws_default")
    manager.add_object(room, {**SAMPLE_OBJECT, "id": "o2"}, second["id"])
    assert [obj["id"] for obj in room.objects_in("ws_default")] == ["o1"]
    assert [obj["id"] for obj in room.objects_in(second["id"])] == ["o2"]
    manager.clear_room(room, second["id"])
    assert [obj["id"] for obj in room.objects] == ["o1"]
    await manager.shutdown()
    await store.close()


async def test_broadcast_filters_by_workspace(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    first_user, first_socket = make_user("a", role="student")
    second_user, second_socket = make_user("b", role="student")
    first_user.workspace_id = "ws_default"
    second_user.workspace_id = second["id"]
    await manager.join("r1", first_user)
    await manager.join("r1", second_user)
    await manager.broadcast(
        room, {"type": "shape_add", "workspaceId": "ws_default"}, workspace_id="ws_default"
    )
    assert [m["type"] for m in first_socket.messages] == ["shape_add"]
    assert second_socket.messages == []
    await manager.shutdown()
    await store.close()


async def test_switch_sends_state_and_finalizes_stroke(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    user, socket = make_user("a", role="student")
    await manager.join("r1", user)
    socket.messages.clear()
    user.strokes["s1"] = {
        "id": "s1",
        "type": "stroke",
        "author": "a",
        "workspaceId": "ws_default",
        "points": [[1, 2], [3, 4]],
        "tool": "brush",
        "color": "#123456",
        "width": 4,
    }
    assert await manager.switch_workspace(room, user, second["id"]) is True
    assert user.workspace_id == second["id"]
    assert [obj["id"] for obj in room.objects_in("ws_default")] == ["s1"]
    assert socket.messages[0]["type"] == "cursor_remove"
    assert socket.messages[-1]["type"] == "workspace_state"
    assert socket.messages[-1]["stateVersion"] == 1
    assert user.strokes == {}
    await manager.shutdown()
    await store.close()


async def test_delete_discards_active_strokes_on_that_page(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    user, _ = make_user("a", role="student")
    await manager.join("r1", user)
    user.workspace_id = second["id"]
    user.strokes["s1"] = {
        "id": "s1",
        "type": "stroke",
        "author": "a",
        "workspaceId": second["id"],
        "points": [[1, 2]],
        "tool": "brush",
        "color": "#123456",
        "width": 4,
    }
    assert manager.delete_workspace(room, second["id"])[1] == "ws_default"
    assert user.strokes == {}
    assert room.objects == []
    await manager.shutdown()
    await store.close()


async def test_add_workspace_position_after_delete(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    third = manager.create_workspace(room, "Третья")
    before = manager.create_workspace(room, "До удаления")
    assert room.workspace_ids() == ["ws_default", second["id"], third["id"], before["id"]]

    assert manager.delete_workspace(room, "ws_default")[1] == second["id"]

    fourth = manager.create_workspace(room, "Четвёртая")
    ordered = room.workspace_list()
    assert [ws["id"] for ws in ordered] == [second["id"], third["id"], before["id"], fourth["id"]]
    assert [ws["position"] for ws in ordered] == [0, 1, 2, 3]
    await manager.shutdown()
    await store.close()


async def test_reorder_rejects_duplicate_ids(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    assert room.workspace_ids() == ["ws_default"]
    assert manager.reorder_workspaces(room, ["ws_default", "ws_default"]) is False
    assert room.workspace_ids() == ["ws_default"]
    await manager.shutdown()
    await store.close()


async def test_move_users_from_deleted_switches_users(tmp_path: Path) -> None:
    _, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    second = manager.create_workspace(room, "Вторая")
    user, socket = make_user("a", role="student")
    await manager.join("r1", user)
    user.workspace_id = second["id"]
    socket.messages.clear()

    deleted, fallback = manager.delete_workspace(room, second["id"])
    assert deleted["id"] == second["id"]
    assert fallback == "ws_default"

    await manager.move_users_from_deleted(room, second["id"], fallback)
    assert user.workspace_id == fallback
    assert socket.messages[-1]["type"] == "workspace_state"
    assert socket.messages[-1]["workspaceId"] == fallback
    await manager.shutdown()
    await store.close()


async def test_workspace_list_persists_across_managers(tmp_path: Path) -> None:
    settings, store, manager = build_manager(tmp_path)
    room = await manager.get_or_create("r1")
    manager.create_workspace(room, "Черновик")
    manager.rename_workspace(room, "ws_default", "Главная")
    await manager.shutdown()

    manager2 = RoomManager(settings, store)
    restored = await manager2.get_or_create("r1")
    assert [ws["id"] for ws in restored.workspace_list()] == room.workspace_ids()
    assert [ws["name"] for ws in restored.workspace_list()] == ["Главная", "Черновик"]
    assert [ws["position"] for ws in restored.workspace_list()] == [0, 1]
    await manager2.shutdown()
    await store.close()
