"""Lock and undo tests for board objects."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import (
    barrier,
    codes,
    connector,
    deleted,
    flush,
    frame,
    recv_until,
    shape,
)


def restored(messages: list[dict]) -> list[dict]:
    return [message for message in messages if message["type"] == "objects_restored"]


def test_student_cannot_change_locked_object(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        tw.send_json({**shape("block"), "shapeType": "process"})
        recv_until(sw, "shape_add")
        tw.send_json({"type": "object_lock", "objectId": "block", "locked": True})
        assert recv_until(sw, "object_lock")["locked"] is True

        sw.send_json({"type": "object_update", "objectId": "block", "x": 90, "y": 90})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json(
            {
                "type": "object_transform",
                "objectId": "block",
                "x": 90,
                "y": 90,
                "rotation": 0,
                "width": 60,
                "height": 50,
            }
        )
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "text_update", "objectId": "block", "content": "нельзя"})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "object_delete", "objectId": "block"})
        assert codes(flush(sw)) == ["locked"]

        tw.send_json({"type": "object_update", "objectId": "block", "x": 90, "y": 90})
        moved = recv_until(sw, "object_update")
        assert (moved["x"], moved["y"]) == (90, 90)


def test_only_staff_can_lock(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        tw.send_json(shape("own"))
        recv_until(sw, "shape_add")
        sw.send_json({"type": "object_lock", "objectId": "own", "locked": True})
        assert codes(flush(sw)) == ["forbidden"]


def test_locked_frame_blocks_children(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json(frame("frame-1"))
        assert "invalid_message" not in codes(flush(sw))
        recv_until(tw, "frame_add")
        sw.send_json(shape("inner"))
        recv_until(tw, "shape_add")

        tw.send_json({"type": "object_lock", "objectId": "frame-1", "locked": True})
        recv_until(sw, "object_lock")
        sw.send_json({"type": "object_update", "objectId": "inner", "x": 50, "y": 50})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "object_delete", "objectId": "inner"})
        assert codes(flush(sw)) == ["locked"]
        sw.send_json({"type": "object_delete", "objectId": "frame-1"})
        assert codes(flush(sw)) == ["locked"]


def test_student_object_is_not_captured_by_locked_frame(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        tw.send_json(frame("frame-1"))
        recv_until(sw, "frame_add")
        tw.send_json({"type": "object_lock", "objectId": "frame-1", "locked": True})
        recv_until(sw, "object_lock")

        sw.send_json(shape("free"))
        assert "frameId" not in recv_until(tw, "shape_add")["object"]


def test_locked_child_blocks_frame_move(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json(frame("frame-1"))
        assert "invalid_message" not in codes(flush(sw))
        recv_until(tw, "frame_add")
        sw.send_json(shape("inner"))
        recv_until(tw, "shape_add")

        tw.send_json({"type": "object_lock", "objectId": "inner", "locked": True})
        recv_until(sw, "object_lock")
        sw.send_json({"type": "frame_move", "objectId": "frame-1", "x": 40, "y": 30})
        assert codes(flush(sw)) == ["locked"]
        assert barrier(sw) is not None


def test_undo_removes_created_shape(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json(shape("s1"))
        recv_until(tw, "shape_add")

        sw.send_json({"type": "undo"})
        events = restored(flush(sw))
        assert len(events) == 1
        assert events[0]["removedIds"] == ["s1"]
        assert events[0]["objects"] == []

    observer = login_user("Наблюдатель", "student")
    with ws_connect(client, observer["token"]) as ow:
        assert ow.receive_json()["objects"] == []


def test_undo_restores_deleted_shape_with_author(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json(shape("s1"))
        recv_until(tw, "shape_add")
        tw.send_json({"type": "object_delete", "objectId": "s1"})
        recv_until(sw, "object_delete")

        tw.send_json({"type": "undo"})
        events = restored(flush(tw))
        assert len(events) == 1
        assert events[0]["removedIds"] == []
        item = events[0]["objects"][0]
        assert item["index"] == 0
        assert item["object"]["id"] == "s1"
        assert item["object"]["author"] == student["user"]["id"]


def test_undo_move_keeps_other_fields(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json(frame("frame-1"))
        recv_until(tw, "frame_add")
        sw.send_json({"type": "frame_move", "objectId": "frame-1", "x": 50, "y": 40})
        recv_until(tw, "frame_moved")
        tw.send_json(
            {"type": "frame_style", "objectId": "frame-1", "fill": "#ff0000", "pattern": "grid"}
        )
        recv_until(sw, "frame_style")

        sw.send_json({"type": "undo"})
        events = restored(flush(sw))
        assert len(events) == 1
        moved = events[0]["objects"][0]["object"]
        assert (moved["x"], moved["y"]) == (0, 0)
        assert moved["fill"] == "#ff0000"
        assert moved["pattern"] == "grid"


def test_undo_frame_creation_releases_children(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        tw.send_json(shape("inner"))
        recv_until(sw, "shape_add")
        tw.send_json(frame("frame-1"))
        recv_until(sw, "frame_add")
        recv_until(sw, "frame_captured")

        tw.send_json({"type": "undo"})
        events = restored(flush(tw))
        assert len(events) == 1
        assert events[0]["removedIds"] == ["frame-1"]
        child = events[0]["objects"][0]["object"]
        assert child["id"] == "inner"
        assert child.get("frameId") is None


def test_undo_frame_deletion_restores_children(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        tw.send_json(frame("frame-1"))
        recv_until(sw, "frame_add")
        tw.send_json(shape("inner"))
        recv_until(sw, "shape_add")
        tw.send_json({"type": "object_delete", "objectId": "frame-1"})
        assert set(deleted(barrier(sw))) == {"frame-1", "inner"}

        tw.send_json({"type": "undo"})
        events = restored(flush(tw))
        assert len(events) == 1
        assert events[0]["removedIds"] == []
        objects = {item["object"]["id"]: item for item in events[0]["objects"]}
        assert set(objects) == {"frame-1", "inner"}
        assert objects["inner"]["object"]["author"] == teacher["user"]["id"]
        assert objects["frame-1"]["index"] < objects["inner"]["index"]


def test_undo_block_deletion_restores_arrows(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        tw.send_json({**shape("flow-a"), "shapeType": "process"})
        recv_until(sw, "shape_add")
        tw.send_json({**shape("flow-b"), "shapeType": "process"})
        recv_until(sw, "shape_add")
        tw.send_json(connector("arrow-1", "flow-a", "flow-b"))
        recv_until(sw, "connector_add")
        tw.send_json({"type": "object_delete", "objectId": "flow-a"})
        assert set(deleted(barrier(sw))) == {"flow-a", "arrow-1"}

        tw.send_json({"type": "undo"})
        events = restored(flush(tw))
        assert len(events) == 1
        objects = {item["object"]["id"] for item in events[0]["objects"]}
        assert objects == {"flow-a", "arrow-1"}


def test_undo_skips_stale_entry(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json(shape("a1"))
        recv_until(tw, "shape_add")
        sw.send_json(shape("a2"))
        recv_until(tw, "shape_add")
        tw.send_json({"type": "object_delete", "objectId": "a2"})
        recv_until(sw, "object_delete")

        sw.send_json({"type": "undo"})
        events = restored(flush(sw))
        assert len(events) == 1
        assert events[0]["removedIds"] == ["a1"]


def test_undo_empty_and_cleared_by_switch(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json({"type": "undo"})
        assert codes(flush(sw)) == ["undo_empty"]

        sw.send_json(shape("a1"))
        recv_until(tw, "shape_add")
        flush(sw)
        sw.send_json({"type": "undo"})
        assert codes(flush(sw)) == ["undo_empty"]


def test_undo_cleared_by_clear(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        tw.send_json(shape("a1"))
        recv_until(sw, "shape_add")
        tw.send_json({"type": "clear"})
        recv_until(sw, "clear")

        tw.send_json({"type": "undo"})
        assert codes(flush(tw)) == ["undo_empty"]


def test_undo_skips_locked_object_for_student(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        tw.receive_json()
        sw.send_json(shape("s1"))
        recv_until(tw, "shape_add")
        sw.send_json({"type": "object_update", "objectId": "s1", "x": 90, "y": 90})
        recv_until(tw, "object_update")
        tw.send_json({"type": "object_lock", "objectId": "s1", "locked": True})
        recv_until(sw, "object_lock")

        sw.send_json({"type": "undo"})
        assert codes(flush(sw)) == ["undo_empty"]
