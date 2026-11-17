"""Lock and undo tests for board objects."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, flush, frame, recv_until, shape


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
