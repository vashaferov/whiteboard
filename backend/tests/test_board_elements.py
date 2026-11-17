"""Board element tests: flow blocks, connectors, frames and object deletion."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect


def recv_until(websocket, type_name: str) -> dict:
    while True:
        message = websocket.receive_json()
        if message["type"] == type_name:
            return message


def barrier(websocket) -> list[dict]:
    """Round-trip a malformed message and return everything before its error."""
    websocket.send_json({"type": "bogus"})
    messages: list[dict] = []
    while True:
        message = websocket.receive_json()
        if message["type"] == "error" and message.get("code") == "invalid_message":
            return messages
        messages.append(message)


def drain_until(websocket, type_name: str) -> list[dict]:
    """Read messages until ``type_name``; the marker itself is not returned."""
    messages: list[dict] = []
    while True:
        message = websocket.receive_json()
        if message["type"] == type_name:
            return messages
        messages.append(message)


def flush(websocket) -> list[dict]:
    """Round-trip a page switch and return everything before its state."""
    websocket.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
    return drain_until(websocket, "workspace_state")


def codes(messages: list[dict]) -> list[str]:
    return [message["code"] for message in messages if message["type"] == "error"]


def deleted(messages: list[dict]) -> list[str]:
    return [m["objectId"] for m in messages if m["type"] == "object_delete"]


def shape(object_id: str) -> dict:
    return {
        "type": "shape_add",
        "objectId": object_id,
        "shapeType": "rect",
        "x": 10,
        "y": 10,
        "width": 50,
        "height": 40,
        "color": "#2563eb",
        "strokeWidth": 4,
        "fill": None,
    }


def test_student_deletes_own_object_but_not_teachers(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()  # init
        student_ws.receive_json()  # init
        teacher_ws.receive_json()  # user_joined of the student

        teacher_ws.send_json(shape("teacher-shape"))
        assert recv_until(student_ws, "shape_add")["object"]["id"] == "teacher-shape"

        student_ws.send_json(shape("student-shape"))
        assert recv_until(teacher_ws, "shape_add")["object"]["id"] == "student-shape"

        # The student removes their own object: no error for the author, and the
        # teacher receives the delete.
        student_ws.send_json({"type": "object_delete", "objectId": "student-shape"})
        assert "forbidden" not in codes(barrier(student_ws))
        assert deleted(barrier(teacher_ws)) == ["student-shape"]

        # The student cannot remove the teacher's object.
        student_ws.send_json({"type": "object_delete", "objectId": "teacher-shape"})
        assert "forbidden" in codes(barrier(student_ws))
        assert deleted(barrier(teacher_ws)) == []

    observer = login_user("Наблюдатель", "student")
    with ws_connect(client, observer["token"]) as observer_ws:
        init = observer_ws.receive_json()
        assert [obj["id"] for obj in init["objects"]] == ["teacher-shape"]


def test_flow_block_accepts_label(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("flow-1"), "shapeType": "process"})
        assert "invalid_message" not in codes(barrier(teacher_ws))
        created = [m for m in barrier(student_ws) if m["type"] == "shape_add"]
        assert created and created[0]["object"]["shapeType"] == "process"

        teacher_ws.send_json({"type": "text_update", "objectId": "flow-1", "content": "Старт"})
        assert "not_text" not in codes(barrier(teacher_ws))
        updates = [m for m in barrier(student_ws) if m["type"] == "text_update"]
        assert updates and updates[0]["object"]["content"] == "Старт"


def test_flow_block_rotation_is_zero(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("flow-2"), "shapeType": "decision"})
        assert "invalid_message" not in codes(barrier(teacher_ws))
        assert [m for m in barrier(student_ws) if m["type"] == "shape_add"]

        teacher_ws.send_json(
            {
                "type": "object_transform",
                "objectId": "flow-2",
                "x": 10,
                "y": 10,
                "width": 60,
                "height": 40,
                "rotation": 45,
            }
        )
        transforms = [m for m in barrier(student_ws) if m["type"] == "object_transform"]
        assert transforms and transforms[0]["object"]["rotation"] == 0


def connector(object_id: str, from_id: str, to_id: str) -> dict:
    return {
        "type": "connector_add",
        "objectId": object_id,
        "fromId": from_id,
        "toId": to_id,
        "color": "#2563eb",
        "strokeWidth": 4,
    }


def test_connector_between_flow_blocks(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("flow-a"), "shapeType": "process"})
        assert recv_until(student_ws, "shape_add")["object"]["id"] == "flow-a"
        teacher_ws.send_json({**shape("flow-b"), "shapeType": "decision"})
        assert recv_until(student_ws, "shape_add")["object"]["id"] == "flow-b"

        teacher_ws.send_json(connector("arrow-1", "flow-a", "flow-b"))
        assert "invalid_message" not in codes(barrier(teacher_ws))
        messages = barrier(student_ws)
        added = [m for m in messages if m["type"] == "connector_add"]
        assert added
        assert added[0]["object"]["fromId"] == "flow-a"
        assert added[0]["object"]["toId"] == "flow-b"

        teacher_ws.send_json(connector("arrow-2", "flow-a", "missing"))
        teacher_ws.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        invalid = drain_until(teacher_ws, "workspace_state")
        assert "invalid_message" in codes(invalid)


def test_deleting_block_removes_its_connectors(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("flow-a"), "shapeType": "process"})
        recv_until(student_ws, "shape_add")
        teacher_ws.send_json({**shape("flow-b"), "shapeType": "terminator"})
        recv_until(student_ws, "shape_add")
        teacher_ws.send_json(connector("arrow-1", "flow-a", "flow-b"))
        assert [m for m in barrier(student_ws) if m["type"] == "connector_add"]

        teacher_ws.send_json({"type": "object_delete", "objectId": "flow-a"})
        barrier(teacher_ws)
        messages = barrier(student_ws)
        assert set(deleted(messages)) == {"flow-a", "arrow-1"}


def frame(
    object_id: str, x: float = 0, y: float = 0, width: float = 200, height: float = 200
) -> dict:
    return {
        "type": "frame_add",
        "objectId": object_id,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "fill": None,
        "pattern": "none",
        "stroke": "#94a3b8",
        "strokeWidth": 2,
    }


def test_frame_captures_existing_objects(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("inner"), "shapeType": "process"})
        recv_until(student_ws, "shape_add")

        teacher_ws.send_json(frame("frame-1"))
        flushed = flush(teacher_ws)
        assert "invalid_message" not in codes(flushed)
        assert recv_until(student_ws, "frame_add")["object"]["id"] == "frame-1"
        captured = [m for m in flushed if m["type"] == "frame_captured"]
        assert captured and captured[0]["objectIds"] == ["inner"]
        captured_student = [m for m in barrier(student_ws) if m["type"] == "frame_captured"]
        assert captured_student and captured_student[0]["objectIds"] == ["inner"]


def test_frame_move_shifts_children(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("inner"), "shapeType": "process"})
        recv_until(student_ws, "shape_add")
        teacher_ws.send_json(frame("frame-1"))
        assert "invalid_message" not in codes(flush(teacher_ws))
        recv_until(student_ws, "frame_add")
        barrier(student_ws)

        teacher_ws.send_json({"type": "frame_move", "objectId": "frame-1", "x": 50, "y": 40})
        moved = [m for m in barrier(student_ws) if m["type"] == "frame_moved"]
        assert moved
        assert moved[0]["x"] == 50 and moved[0]["y"] == 40
        assert moved[0]["children"] == [{"id": "inner", "x": 60, "y": 50}]


def test_frame_style_is_broadcast(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json(frame("frame-1"))
        assert "invalid_message" not in codes(flush(teacher_ws))
        recv_until(student_ws, "frame_add")
        teacher_ws.send_json(
            {"type": "frame_style", "objectId": "frame-1", "fill": "#ff0000", "pattern": "grid"}
        )
        styled = [m for m in barrier(student_ws) if m["type"] == "frame_style"]
        assert styled and styled[0]["fill"] == "#ff0000"
        assert styled[0]["pattern"] == "grid"


def test_frame_delete_removes_children(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("inner"), "shapeType": "process"})
        recv_until(student_ws, "shape_add")
        teacher_ws.send_json(frame("frame-1"))
        assert "invalid_message" not in codes(flush(teacher_ws))
        recv_until(student_ws, "frame_add")
        barrier(student_ws)

        teacher_ws.send_json({"type": "object_delete", "objectId": "frame-1"})
        barrier(teacher_ws)
        removed = deleted(barrier(student_ws))
        assert set(removed) == {"frame-1", "inner"}


def test_student_cannot_delete_frame_with_foreign_child(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        student_ws.send_json(frame("student-frame"))
        assert "invalid_message" not in codes(flush(student_ws))
        recv_until(teacher_ws, "frame_add")

        teacher_ws.send_json({**shape("foreign"), "shapeType": "process"})
        recv_until(student_ws, "shape_add")

        student_ws.send_json({"type": "object_delete", "objectId": "student-frame"})
        assert "forbidden" in codes(barrier(student_ws))


def test_student_deletes_own_frame_with_own_children(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        student_ws.send_json(frame("own-frame"))
        assert "invalid_message" not in codes(flush(student_ws))
        recv_until(teacher_ws, "frame_add")

        student_ws.send_json({**shape("own-block"), "shapeType": "process"})
        assert "invalid_message" not in codes(flush(student_ws))
        attached = recv_until(teacher_ws, "shape_add")["object"]
        assert attached["frameId"] == "own-frame"

        student_ws.send_json({"type": "object_delete", "objectId": "own-frame"})
        own = deleted(barrier(student_ws))
        assert set(own) == {"own-block"}
        assert set(deleted(barrier(teacher_ws))) == {"own-frame", "own-block"}

    observer = login_user("Наблюдатель", "student")
    with ws_connect(client, observer["token"]) as observer_ws:
        assert observer_ws.receive_json()["objects"] == []


def test_transform_recomputes_frame_id(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with (
        ws_connect(client, teacher["token"]) as teacher_ws,
        ws_connect(client, student["token"]) as student_ws,
    ):
        teacher_ws.receive_json()
        student_ws.receive_json()
        teacher_ws.receive_json()

        teacher_ws.send_json({**shape("inner"), "shapeType": "process"})
        recv_until(student_ws, "shape_add")
        teacher_ws.send_json(frame("frame-1"))
        assert "invalid_message" not in codes(flush(teacher_ws))
        recv_until(student_ws, "frame_add")
        barrier(student_ws)

        teacher_ws.send_json({"type": "object_update", "objectId": "inner", "x": 500, "y": 500})
        outside = [m for m in barrier(student_ws) if m["type"] == "object_update"]
        assert outside and outside[0].get("frameId") is None

        teacher_ws.send_json({"type": "object_update", "objectId": "inner", "x": 50, "y": 50})
        inside = [m for m in barrier(student_ws) if m["type"] == "object_update"]
        assert inside and inside[0].get("frameId") == "frame-1"
