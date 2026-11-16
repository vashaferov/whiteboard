"""Интеграционные тесты WebSocket-комнат."""

from __future__ import annotations

import base64
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from tests.support import cookie, ws_connect

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

SHAPE = {
    "type": "shape_add",
    "objectId": "shape-1",
    "shapeType": "rect",
    "x": 10,
    "y": 20,
    "width": 100,
    "height": 60,
    "color": "#2563eb",
    "strokeWidth": 4,
    "fill": None,
}


def test_init_and_user_joined(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        init = teacher_ws.receive_json()
        assert init["type"] == "init"
        assert init["clientId"] == teacher["user"]["id"]
        assert init["role"] == "teacher"
        assert [user["id"] for user in init["users"]] == [teacher["user"]["id"]]
        assert init["objects"] == []
        assert init["permissions"]["canClear"] is True
        assert init["board"] == {"width": 1600, "height": 900}
        assert init["workspaces"] == [{"id": "ws_default", "name": "Страница 1", "position": 0}]
        assert init["workspaceId"] == "ws_default"
        assert init["permissions"]["canManageWorkspaces"] is True

        with ws_connect(client, student["token"]) as student_ws:
            student_init = student_ws.receive_json()
            assert student_init["type"] == "init"
            assert {user["id"] for user in student_init["users"]} == {
                teacher["user"]["id"],
                student["user"]["id"],
            }
            assert student_init["permissions"]["canClear"] is False
            assert student_init["permissions"]["canManageWorkspaces"] is False

            joined = teacher_ws.receive_json()
            assert joined["type"] == "user_joined"
            assert joined["user"]["id"] == student["user"]["id"]


def test_shape_broadcast_and_late_join_snapshot(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    late = login_user("Опоздавший", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()  # user_joined

            student_ws.send_json(SHAPE)
            event = teacher_ws.receive_json()
            assert event["type"] == "shape_add"
            assert event["object"]["id"] == "shape-1"
            assert event["object"]["author"] == student["user"]["id"]
            assert event["object"]["x"] == 10
            assert event["object"]["seq"] == 1

            with ws_connect(client, late["token"]) as late_ws:
                late_init = late_ws.receive_json()
                assert late_init["type"] == "init"
                assert [obj["id"] for obj in late_init["objects"]] == ["shape-1"]
                assert late_init["userCount"] == 3


def test_stroke_lifecycle(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            teacher_ws.send_json(
                {
                    "type": "stroke_start",
                    "objectId": "stroke-1",
                    "tool": "brush",
                    "color": "#dc2626",
                    "width": 6,
                    "point": {"x": 5, "y": 6},
                }
            )
            started = student_ws.receive_json()
            assert started["type"] == "stroke_start"
            assert started["object"]["points"] == [[5, 6]]

            teacher_ws.send_json(
                {
                    "type": "stroke_point",
                    "objectId": "stroke-1",
                    "point": {"x": 15, "y": 16},
                }
            )
            moved = student_ws.receive_json()
            assert moved == {
                "type": "stroke_point",
                "id": teacher["user"]["id"],
                "objectId": "stroke-1",
                "point": [15, 16],
                "workspaceId": "ws_default",
            }

            teacher_ws.send_json({"type": "stroke_end", "objectId": "stroke-1"})
            finished = student_ws.receive_json()
            assert finished["type"] == "stroke_end"
            assert finished["object"]["points"] == [[5, 6], [15, 16]]
            assert finished["object"]["seq"] == 1


def test_clear_permissions(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            student_ws.send_json(SHAPE)
            assert teacher_ws.receive_json()["type"] == "shape_add"

            student_ws.send_json({"type": "clear"})
            denied = student_ws.receive_json()
            assert denied["type"] == "error"
            assert denied["code"] == "forbidden"

            teacher_ws.send_json({"type": "clear"})
            cleared = student_ws.receive_json()
            assert cleared["type"] == "clear"
            assert cleared["id"] == teacher["user"]["id"]


def test_move_permissions(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            teacher_ws.send_json({**SHAPE, "objectId": "teacher-shape"})
            assert student_ws.receive_json()["type"] == "shape_add"

            student_ws.send_json(
                {"type": "object_update", "objectId": "teacher-shape", "x": 1, "y": 2}
            )
            denied = student_ws.receive_json()
            assert denied["type"] == "error"
            assert denied["code"] == "forbidden"

            teacher_ws.send_json(
                {"type": "object_update", "objectId": "teacher-shape", "x": 30, "y": 40}
            )
            moved = student_ws.receive_json()
            assert moved["type"] == "object_update"
            assert (moved["x"], moved["y"]) == (30, 40)

            student_ws.send_json({**SHAPE, "objectId": "student-shape"})
            assert teacher_ws.receive_json()["type"] == "shape_add"

            student_ws.send_json(
                {"type": "object_update", "objectId": "student-shape", "x": 7, "y": 8}
            )
            own_move = teacher_ws.receive_json()
            assert own_move["type"] == "object_update"
            assert (own_move["x"], own_move["y"]) == (7, 8)

            teacher_ws.send_json(
                {"type": "object_update", "objectId": "student-shape", "x": 9, "y": 10}
            )
            forced_move = student_ws.receive_json()
            assert forced_move["type"] == "object_update"
            assert (forced_move["x"], forced_move["y"]) == (9, 10)


def test_delete_permissions(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            teacher_ws.send_json({**SHAPE, "objectId": "to-delete"})
            assert student_ws.receive_json()["type"] == "shape_add"

            student_ws.send_json({"type": "object_delete", "objectId": "to-delete"})
            denied = student_ws.receive_json()
            assert denied["type"] == "error"
            assert denied["code"] == "forbidden"

            teacher_ws.send_json({"type": "object_delete", "objectId": "to-delete"})
            deleted = student_ws.receive_json()
            assert deleted["type"] == "object_delete"
            assert deleted["objectId"] == "to-delete"


def test_invalid_message_keeps_connection(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            student_ws.send_text("not a json")
            error = student_ws.receive_json()
            assert error["type"] == "error"
            assert error["code"] == "invalid_message"

            student_ws.send_json(
                {
                    "type": "cursor",
                    "x": 1,
                    "y": 2,
                    "unexpected": True,
                }
            )
            error = student_ws.receive_json()
            assert error["code"] == "invalid_message"

            student_ws.send_json(SHAPE)
            assert teacher_ws.receive_json()["type"] == "shape_add"


def test_teacher_can_kick_student(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            teacher_ws.send_json({"type": "kick", "clientId": student["user"]["id"]})
            kicked = student_ws.receive_json()
            assert kicked["type"] == "kicked"

            left = teacher_ws.receive_json()
            assert left == {"type": "user_left", "id": student["user"]["id"]}


def test_image_add_requires_uploaded_file(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    upload = client.post(
        "/api/upload",
        cookies=cookie(teacher["token"]),
        files={"file": ("pixel.png", PNG_1X1, "image/png")},
    )
    assert upload.status_code == 200
    url = upload.json()["url"]

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            teacher_ws.send_json(
                {
                    "type": "image_add",
                    "objectId": "image-1",
                    "url": url,
                    "x": 10,
                    "y": 10,
                    "width": 100,
                    "height": 50,
                }
            )
            added = student_ws.receive_json()
            assert added["type"] == "image_add"
            assert added["object"]["url"] == url

            teacher_ws.send_json(
                {
                    "type": "image_add",
                    "objectId": "image-2",
                    "url": "/uploads/missing.png",
                    "x": 10,
                    "y": 10,
                    "width": 100,
                    "height": 50,
                }
            )
            error = teacher_ws.receive_json()
            assert error == {
                "type": "error",
                "code": "unknown_image",
                "message": "Изображение не найдено",
            }


def test_object_transform_permissions_and_broadcast(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            teacher_ws.send_json({**SHAPE, "objectId": "teacher-shape"})
            assert student_ws.receive_json()["type"] == "shape_add"

            student_ws.send_json(
                {
                    "type": "object_transform",
                    "objectId": "teacher-shape",
                    "x": 50,
                    "y": 60,
                    "width": 200,
                    "height": 100,
                    "rotation": 30,
                }
            )
            denied = student_ws.receive_json()
            assert denied["type"] == "error"
            assert denied["code"] == "forbidden"

            teacher_ws.send_json(
                {
                    "type": "object_transform",
                    "objectId": "teacher-shape",
                    "x": 50,
                    "y": 60,
                    "width": 200,
                    "height": 100,
                    "rotation": 30,
                }
            )
            transformed = student_ws.receive_json()
            assert transformed["type"] == "object_transform"
            assert transformed["object"]["x"] == 50
            assert transformed["object"]["y"] == 60
            assert transformed["object"]["width"] == 200
            assert transformed["object"]["height"] == 100
            assert transformed["object"]["rotation"] == 30

            student_ws.send_json({**SHAPE, "objectId": "student-shape"})
            assert teacher_ws.receive_json()["type"] == "shape_add"
            student_ws.send_json(
                {
                    "type": "object_transform",
                    "objectId": "student-shape",
                    "x": 7,
                    "y": 8,
                    "width": 90,
                    "height": 40,
                    "rotation": -15,
                }
            )
            own_transform = teacher_ws.receive_json()
            assert own_transform["type"] == "object_transform"
            assert own_transform["object"]["rotation"] == -15


def test_object_transform_rejects_strokes(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        teacher_ws.send_json(
            {
                "type": "stroke_start",
                "objectId": "stroke-1",
                "tool": "brush",
                "color": "#2563eb",
                "width": 4,
                "point": {"x": 1, "y": 2},
            }
        )
        teacher_ws.send_json({"type": "stroke_end", "objectId": "stroke-1"})
        teacher_ws.send_json(
            {
                "type": "object_transform",
                "objectId": "stroke-1",
                "x": 10,
                "y": 10,
                "rotation": 10,
            }
        )
        error = teacher_ws.receive_json()
        assert error["type"] == "error"
        assert error["code"] == "not_transformable"


def test_text_update_permissions_and_broadcast(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")

    text = {
        "type": "text_add",
        "objectId": "text-1",
        "content": "Старый текст",
        "x": 10,
        "y": 20,
        "color": "#111827",
        "fontSize": 24,
    }

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        with ws_connect(client, student["token"]) as student_ws:
            student_ws.receive_json()
            teacher_ws.receive_json()

            teacher_ws.send_json(text)
            assert student_ws.receive_json()["type"] == "text_add"

            student_ws.send_json({"type": "text_update", "objectId": "text-1", "content": "Взлом"})
            denied = student_ws.receive_json()
            assert denied["type"] == "error"
            assert denied["code"] == "forbidden"

            teacher_ws.send_json(
                {"type": "text_update", "objectId": "text-1", "content": "Новый текст"}
            )
            updated = student_ws.receive_json()
            assert updated["type"] == "text_update"
            assert updated["object"]["content"] == "Новый текст"

            teacher_ws.send_json(
                {
                    "type": "text_update",
                    "objectId": "missing",
                    "content": "Ничего",
                }
            )
            # Нет объекта — событие игнорируется без ошибки.

            student_ws.send_json({**SHAPE, "objectId": "shape-1"})
            assert teacher_ws.receive_json()["type"] == "shape_add"
            teacher_ws.send_json(
                {"type": "text_update", "objectId": "shape-1", "content": "Не текст"}
            )
            error = teacher_ws.receive_json()
            assert error["type"] == "error"
            assert error["code"] == "not_text"


def test_snapshot_restored_after_room_closure(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        teacher_ws.send_json(SHAPE)

    time.sleep(0.2)

    with ws_connect(client, teacher["token"]) as teacher_ws:
        init = teacher_ws.receive_json()
        assert [obj["id"] for obj in init["objects"]] == ["shape-1"]


def test_transform_and_text_edit_restore_after_room_closure(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")

    with ws_connect(client, teacher["token"]) as teacher_ws:
        teacher_ws.receive_json()
        teacher_ws.send_json(
            {
                "type": "text_add",
                "objectId": "text-1",
                "content": "До",
                "x": 10,
                "y": 20,
                "color": "#111827",
                "fontSize": 24,
            }
        )
        teacher_ws.send_json(
            {
                "type": "object_transform",
                "objectId": "text-1",
                "x": 100,
                "y": 120,
                "rotation": 25,
                "fontSize": 48,
            }
        )
        teacher_ws.send_json({"type": "text_update", "objectId": "text-1", "content": "После"})

    time.sleep(0.2)

    with ws_connect(client, teacher["token"]) as teacher_ws:
        init = teacher_ws.receive_json()
        assert len(init["objects"]) == 1
        restored = init["objects"][0]
        assert restored["content"] == "После"
        assert restored["x"] == 100
        assert restored["y"] == 120
        assert restored["rotation"] == 25
        assert restored["fontSize"] == 48


def test_websocket_requires_valid_session(client: TestClient) -> None:
    with ws_connect(client, "missing-session", "room-1") as ws:
        with pytest.raises(WebSocketDisconnect) as invalid:
            ws.receive_json()
        assert invalid.value.code == 4401
