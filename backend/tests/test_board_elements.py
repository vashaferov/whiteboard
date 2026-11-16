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
