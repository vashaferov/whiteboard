"""Redis-backed room sharing: Pub/Sub, shared objects and presence."""

from __future__ import annotations

import asyncio
from typing import Any

from app.config import Settings
from app.services.room_manager import ConnectedUser, RateLimiter, RoomManager
from app.services.storage import SnapshotStore
from fakeredis import FakeAsyncRedis


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
    manager_a.add_object(room_a, obj, "ws_default")
    await manager_a.broadcast(
        room_a, {"type": "shape_add", "id": "u-a", "workspaceId": "ws_default", "object": obj}
    )

    await wait_for(lambda: room_b.get_object("shape-1") is not None)
    assert websocket_b.messages[-1]["type"] == "shape_add"

    manager_a.update_object_fields(room_a, "shape-1", x=75, rotation=30)
    await manager_a.broadcast(
        room_a,
        {
            "type": "object_transform",
            "id": "u-a",
            "workspaceId": "ws_default",
            "object": room_a.get_object("shape-1"),
        },
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

    manager_a.add_object(room_a, {**obj, "id": "shape-2"}, "ws_default")
    await manager_a.broadcast(
        room_a,
        {
            "type": "shape_add",
            "id": "u-a",
            "workspaceId": "ws_default",
            "object": room_a.get_object("shape-2"),
        },
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


async def test_empty_redis_is_seeded_from_snapshot(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    await manager_a.startup()
    room = await manager_a.get_or_create("shared")
    extra = manager_a.create_workspace(room, "Вторая")
    await manager_a.broadcast(room, {"type": "workspace_created", "workspace": extra})
    manager_a.add_object(room, {"id": "o1", "type": "shape"}, extra["id"])
    await manager_a.broadcast(
        room, {"type": "shape_add", "workspaceId": extra["id"], "object": room.get_object("o1")}
    )
    await wait_for_hash_field(first_redis, "whiteboard:room:shared:workspaces", extra["id"])

    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_b.startup()
    room_b = await manager_b.get_or_create("shared")
    assert room_b.workspace_ids() == ["ws_default", extra["id"]]
    assert room_b.get_object("o1")["workspaceId"] == extra["id"]
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_redis_workspaces_beat_stale_sqlite(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    store = SnapshotStore(tmp_path / "snap.db")
    await store.save(
        "shared",
        [{"id": "old", "workspaceId": "ws_default"}],
        1,
        [{"id": "ws_default", "name": "Старая", "position": 0}],
    )
    manager_a = RoomManager(settings, store, redis_client=first_redis)
    await manager_a.startup()
    room_a = await manager_a.get_or_create("shared")
    manager_a.rename_workspace(room_a, "ws_default", "Живая")
    await manager_a.broadcast(
        room_a,
        {
            "type": "workspace_renamed",
            "workspaceId": "ws_default",
            "name": "Живая",
        },
    )
    extra = manager_a.create_workspace(room_a, "Новая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": extra})

    manager_b = RoomManager(settings, store, redis_client=second_redis)
    await manager_b.startup()
    room_b = await manager_b.get_or_create("shared")
    assert room_b.workspace_ids() == ["ws_default", extra["id"]]
    assert room_b.workspace_list()[0]["name"] == "Живая"
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_remote_pull_prepares_on_owner_instance(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()
    teacher, _ = make_user("t", "teacher")
    student, socket_b = make_user("s")
    room_a = await manager_a.join("lesson", teacher)
    room_b = await manager_b.join("lesson", student)
    extra = manager_a.create_workspace(room_a, "Вторая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": extra})
    await wait_for_hash_field(first_redis, "whiteboard:room:lesson:workspaces", extra["id"])
    teacher.workspace_id = extra["id"]
    socket_b.messages.clear()

    assert await manager_a.pull_users(room_a, teacher, client_ids=["s"], all=False) == 1
    await wait_for(lambda: any(m["type"] == "workspace_prepare_move" for m in socket_b.messages))
    prepare = next(m for m in socket_b.messages if m["type"] == "workspace_prepare_move")
    await manager_b.handle_move_ack(room_b, student, prepare["requestId"])
    assert student.workspace_id == extra["id"]
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_remote_object_delivery_is_workspace_scoped(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()

    teacher, _ = make_user("t", "teacher")
    page_a_user, socket_a = make_user("u-a")
    page_b_user, socket_b = make_user("u-b")
    room_a = await manager_a.join("lesson", teacher)
    room_b = await manager_b.join("lesson", page_a_user)
    await manager_b.join("lesson", page_b_user)
    extra = manager_a.create_workspace(room_a, "Вторая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": extra})
    # Wait until the metadata event has reached both local users before clearing.
    await wait_for(lambda: any(m["type"] == "workspace_created" for m in socket_a.messages))
    await wait_for(lambda: any(m["type"] == "workspace_created" for m in socket_b.messages))
    page_b_user.workspace_id = extra["id"]
    socket_a.messages.clear()
    socket_b.messages.clear()

    manager_a.add_object(room_a, {"id": "shape-b", "type": "shape"}, extra["id"])
    await manager_a.broadcast(
        room_a,
        {
            "type": "shape_add",
            "workspaceId": extra["id"],
            "object": room_a.get_object("shape-b"),
        },
    )

    await wait_for(lambda: any(m["type"] == "shape_add" for m in socket_b.messages))
    assert room_b.get_object("shape-b") is not None
    assert socket_a.messages == []
    assert [m["type"] for m in socket_b.messages] == ["shape_add"]
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_redis_clear_and_delete_are_page_scoped(settings, tmp_path, redis_pair) -> None:
    first_redis, _second_redis = redis_pair
    manager = make_manager(settings, tmp_path, "a", first_redis)
    await manager.startup()
    room = await manager.get_or_create("lesson")
    second = manager.create_workspace(room, "Вторая")
    await manager.broadcast(room, {"type": "workspace_created", "workspace": second})
    manager.add_object(room, {"id": "o-default", "type": "shape"}, "ws_default")
    manager.add_object(room, {"id": "o-second", "type": "shape"}, second["id"])
    await manager.broadcast(
        room,
        {
            "type": "shape_add",
            "workspaceId": "ws_default",
            "object": room.get_object("o-default"),
        },
    )
    await manager.broadcast(
        room,
        {"type": "shape_add", "workspaceId": second["id"], "object": room.get_object("o-second")},
    )

    objects_key = "whiteboard:room:lesson:objects"
    workspaces_key = "whiteboard:room:lesson:workspaces"
    assert await first_redis.hget(objects_key, "o-default") is not None
    assert await first_redis.hget(objects_key, "o-second") is not None

    # clear only page B's objects.
    manager.clear_room(room, second["id"])
    await manager.broadcast(
        room, {"type": "clear", "id": "t", "workspaceId": second["id"]}, workspace_id=second["id"]
    )
    assert await first_redis.hget(objects_key, "o-second") is None
    assert await first_redis.hget(objects_key, "o-default") is not None

    # delete page B removes its metadata and objects, leaving page A intact.
    manager.add_object(room, {"id": "o-second2", "type": "shape"}, second["id"])
    await manager.broadcast(
        room,
        {"type": "shape_add", "workspaceId": second["id"], "object": room.get_object("o-second2")},
    )
    manager.delete_workspace(room, second["id"])
    await manager.broadcast(
        room,
        {
            "type": "workspace_deleted",
            "workspaceId": second["id"],
            "fallbackId": "ws_default",
        },
    )
    assert await first_redis.hget(workspaces_key, second["id"]) is None
    assert await first_redis.hget(workspaces_key, "ws_default") is not None
    assert await first_redis.hget(objects_key, "o-second2") is None
    assert await first_redis.hget(objects_key, "o-default") is not None
    await manager.shutdown()


async def test_remote_workspace_renamed_reaches_all_pages(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()
    teacher, _ = make_user("t", "teacher")
    student, socket_b = make_user("s")
    room_a = await manager_a.join("lesson", teacher)
    room_b = await manager_b.join("lesson", student)
    extra = manager_a.create_workspace(room_a, "Вторая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": extra})
    await wait_for(lambda: any(m["type"] == "workspace_created" for m in socket_b.messages))
    # The student is on a different page than the one being renamed.
    student.workspace_id = extra["id"]
    socket_b.messages.clear()

    manager_a.rename_workspace(room_a, "ws_default", "Живая")
    await manager_a.broadcast(
        room_a,
        {"type": "workspace_renamed", "workspaceId": "ws_default", "name": "Живая"},
    )

    await wait_for(lambda: any(m["type"] == "workspace_renamed" for m in socket_b.messages))
    assert socket_b.messages[-1]["name"] == "Живая"
    assert room_b.get_workspace("ws_default")["name"] == "Живая"
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_remote_workspace_deleted_reaches_user_after_move(
    settings, tmp_path, redis_pair
) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()
    teacher, _ = make_user("t", "teacher")
    student, socket_b = make_user("s")
    room_a = await manager_a.join("lesson", teacher)
    await manager_b.join("lesson", student)
    extra = manager_a.create_workspace(room_a, "Вторая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": extra})
    await wait_for(lambda: any(m["type"] == "workspace_created" for m in socket_b.messages))
    student.workspace_id = extra["id"]
    socket_b.messages.clear()

    manager_a.delete_workspace(room_a, extra["id"])
    await manager_a.broadcast(
        room_a,
        {"type": "workspace_deleted", "workspaceId": extra["id"], "fallbackId": "ws_default"},
    )

    await wait_for(lambda: any(m["type"] == "workspace_deleted" for m in socket_b.messages))
    # The student was moved to the fallback page but still received the event.
    assert student.workspace_id == "ws_default"
    assert socket_b.messages[-1]["type"] == "workspace_deleted"
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_finalized_stroke_end_is_workspace_scoped(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()

    owner, owner_socket = make_user("u-a")
    other_page, other_socket = make_user("u-b")
    same_page, same_socket = make_user("u-c")

    room_a = await manager_a.join("lesson", owner)
    room_b = await manager_b.join("lesson", other_page)
    await manager_b.join("lesson", same_page)

    second = manager_a.create_workspace(room_a, "Вторая")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": second})
    await wait_for(lambda: room_b.get_workspace(second["id"]) is not None)

    owner.workspace_id = "ws_default"
    other_page.workspace_id = second["id"]
    same_page.workspace_id = "ws_default"

    owner.strokes["s1"] = {
        "id": "s1",
        "type": "stroke",
        "author": "u-a",
        "workspaceId": "ws_default",
        "points": [[1, 2], [3, 4]],
        "tool": "brush",
        "color": "#123456",
        "width": 4,
    }
    owner_socket.messages.clear()
    other_socket.messages.clear()
    same_socket.messages.clear()

    assert await manager_a.switch_workspace(room_a, owner, second["id"]) is True

    # A same-page viewer receives the finalized stroke with its workspace id.
    await wait_for(lambda: any(m["type"] == "stroke_end" for m in same_socket.messages))
    stroke_end = next(m for m in same_socket.messages if m["type"] == "stroke_end")
    assert stroke_end["object"]["id"] == "s1"
    assert stroke_end["workspaceId"] == "ws_default"

    # The other-page user must not receive the finalized stroke.
    assert all(m["type"] != "stroke_end" for m in other_socket.messages)

    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_cursor_remove_is_workspace_scoped(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "a", first_redis)
    manager_b = make_manager(settings, tmp_path, "b", second_redis)
    await manager_a.startup()
    await manager_b.startup()

    mover, mover_socket = make_user("u-a")
    other_page, other_socket = make_user("u-b")
    same_page, same_socket = make_user("u-c")

    room_a = await manager_a.join("lesson", mover)
    room_b = await manager_b.join("lesson", other_page)
    await manager_b.join("lesson", same_page)

    second = manager_a.create_workspace(room_a, "Вторая")
    third = manager_a.create_workspace(room_a, "Третья")
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": second})
    await manager_a.broadcast(room_a, {"type": "workspace_created", "workspace": third})
    await wait_for(
        lambda: (
            room_b.get_workspace(second["id"]) is not None
            and room_b.get_workspace(third["id"]) is not None
        )
    )

    mover.workspace_id = "ws_default"
    other_page.workspace_id = third["id"]
    same_page.workspace_id = "ws_default"

    mover_socket.messages.clear()
    other_socket.messages.clear()
    same_socket.messages.clear()

    assert await manager_a.switch_workspace(room_a, mover, second["id"]) is True

    # The viewer still on the default page receives the mover's cursor_remove.
    await wait_for(lambda: any(m["type"] == "cursor_remove" for m in same_socket.messages))
    removed = next(m for m in same_socket.messages if m["type"] == "cursor_remove")
    assert removed["id"] == "u-a"
    assert removed["workspaceId"] == "ws_default"

    # The user on another page must not receive the cursor_remove.
    assert all(m["type"] != "cursor_remove" for m in other_socket.messages)

    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_purge_room_keys_removes_only_room_state(
    settings: Settings, tmp_path, redis_pair
) -> None:
    first_redis, _ = redis_pair
    manager = make_manager(settings, tmp_path, "purge", first_redis)
    await first_redis.set("whiteboard:room:a:seq", "1")
    await first_redis.hset("whiteboard:room:b:presence", mapping={"u": "{}"})
    await first_redis.set("whiteboard:keep", "keep")

    assert await manager.purge_room_keys() == 2
    assert await first_redis.get("whiteboard:keep") == "keep"
    assert await first_redis.keys("whiteboard:room:*") == []


async def test_connector_add_is_shared(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "conn-a", first_redis)
    manager_b = make_manager(settings, tmp_path, "conn-b", second_redis)
    room_a = await manager_a.get_or_create("room-conn")
    room_b = await manager_b.get_or_create("room-conn")

    obj = {
        "id": "c1",
        "type": "connector",
        "author": "u",
        "workspaceId": "ws_default",
        "fromId": "a",
        "toId": "b",
        "color": "#2563eb",
        "strokeWidth": 4,
    }
    manager_a.add_object(room_a, obj, "ws_default")
    await manager_a.broadcast(
        room_a,
        {"type": "connector_add", "id": "u", "object": obj, "workspaceId": "ws_default"},
    )

    await wait_for(lambda: room_b.get_object("c1") is not None)
    assert room_b.get_object("c1")["fromId"] == "a"

    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_frame_moved_is_shared(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "frame-a", first_redis)
    manager_b = make_manager(settings, tmp_path, "frame-b", second_redis)
    room_a = await manager_a.get_or_create("room-frame")
    room_b = await manager_b.get_or_create("room-frame")

    frame = {
        "id": "frame-1",
        "type": "frame",
        "author": "u",
        "workspaceId": "ws_default",
        "x": 0,
        "y": 0,
        "width": 200,
        "height": 200,
        "fill": None,
        "pattern": "none",
        "stroke": "#94a3b8",
        "strokeWidth": 2,
    }
    child = {
        "id": "child",
        "type": "shape",
        "shapeType": "process",
        "author": "u",
        "workspaceId": "ws_default",
        "x": 20,
        "y": 20,
        "width": 50,
        "height": 40,
        "color": "#2563eb",
        "strokeWidth": 4,
        "fill": None,
        "frameId": "frame-1",
    }
    manager_a.add_object(room_a, frame, "ws_default")
    manager_a.add_object(room_a, child, "ws_default")
    await manager_a.broadcast(
        room_a,
        {
            "type": "shape_add",
            "id": "u",
            "object": child,
            "workspaceId": "ws_default",
        },
    )
    await manager_a.broadcast(
        room_a,
        {
            "type": "frame_add",
            "id": "u",
            "object": frame,
            "workspaceId": "ws_default",
        },
    )
    await manager_a.broadcast(
        room_a,
        {
            "type": "frame_captured",
            "frameId": "frame-1",
            "objectIds": ["child"],
            "workspaceId": "ws_default",
        },
    )
    await wait_for(lambda: room_b.get_object("child") is not None)

    frame["x"] = 50
    frame["y"] = 40
    child["x"] = 70
    child["y"] = 60
    await manager_a.broadcast(
        room_a,
        {
            "type": "frame_moved",
            "frameId": "frame-1",
            "x": 50,
            "y": 40,
            "children": [{"id": "child", "x": 70, "y": 60}],
            "workspaceId": "ws_default",
        },
    )

    def applied() -> bool:
        remote_frame = room_b.get_object("frame-1")
        remote_child = room_b.get_object("child")
        return (
            remote_frame is not None
            and remote_frame["x"] == 50
            and remote_child is not None
            and remote_child["x"] == 70
            and remote_child.get("frameId") == "frame-1"
        )

    await wait_for(applied)
    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_object_lock_is_shared(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "lock-a", first_redis)
    manager_b = make_manager(settings, tmp_path, "lock-b", second_redis)
    room_a = await manager_a.get_or_create("room-lock")
    room_b = await manager_b.get_or_create("room-lock")

    obj = {
        "id": "locked",
        "type": "shape",
        "shapeType": "rect",
        "author": "u",
        "workspaceId": "ws_default",
        "x": 0,
        "y": 0,
        "width": 40,
        "height": 40,
    }
    manager_a.add_object(room_a, obj, "ws_default")
    await manager_a.broadcast(
        room_a,
        {
            "type": "shape_add",
            "id": "u",
            "object": obj,
            "workspaceId": "ws_default",
        },
    )
    await wait_for(lambda: room_b.get_object("locked") is not None)

    obj["locked"] = True
    await manager_a.broadcast(
        room_a,
        {
            "type": "object_lock",
            "objectId": "locked",
            "locked": True,
            "workspaceId": "ws_default",
        },
    )
    await wait_for(lambda: room_b.get_object("locked").get("locked") is True)

    await manager_a.shutdown()
    await manager_b.shutdown()


async def test_objects_restored_is_shared(settings, tmp_path, redis_pair) -> None:
    first_redis, second_redis = redis_pair
    manager_a = make_manager(settings, tmp_path, "undo-a", first_redis)
    manager_b = make_manager(settings, tmp_path, "undo-b", second_redis)
    room_a = await manager_a.get_or_create("room-undo")
    room_b = await manager_b.get_or_create("room-undo")

    obj = {
        "id": "restored",
        "type": "shape",
        "shapeType": "rect",
        "author": "u",
        "workspaceId": "ws_default",
        "x": 0,
        "y": 0,
        "width": 40,
        "height": 40,
    }
    manager_a.add_object(room_a, obj, "ws_default")
    await manager_a.broadcast(
        room_a,
        {
            "type": "shape_add",
            "id": "u",
            "object": obj,
            "workspaceId": "ws_default",
        },
    )
    await wait_for(lambda: room_b.get_object("restored") is not None)

    obj["x"] = 77
    await manager_a.broadcast(
        room_a,
        {
            "type": "objects_restored",
            "removedIds": [],
            "objects": [{"index": None, "object": obj}],
            "workspaceId": "ws_default",
        },
    )
    await wait_for(lambda: room_b.get_object("restored").get("x") == 77)

    room_a.remove_object("restored")
    await manager_a.broadcast(
        room_a,
        {
            "type": "objects_restored",
            "removedIds": ["restored"],
            "objects": [],
            "workspaceId": "ws_default",
        },
    )
    await wait_for(lambda: room_b.get_object("restored") is None)

    await manager_a.shutdown()
    await manager_b.shutdown()
