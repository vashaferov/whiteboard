"""Edge cases: upload limits, disconnect during a stroke, concurrency, validation."""

from __future__ import annotations

import base64
import json

from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

STROKE_START = {
    "type": "stroke_start",
    "objectId": "stroke-1",
    "tool": "brush",
    "color": "#2563eb",
    "width": 4,
}


def login(client: TestClient, name: str, role: str = "student") -> dict:
    payload = {"name": name, "roomId": "edge", "role": role}
    if role == "teacher":
        payload["code"] = "secret-code"
    response = client.post("/api/login", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def ws_path(token: str, room: str = "edge") -> str:
    import urllib.parse

    return f"/ws/{room}?token={urllib.parse.quote(token)}"


def test_upload_over_limit_is_rejected(settings: Settings) -> None:
    small = settings.model_copy(update={"max_upload_mb": 0})
    with TestClient(create_app(small)) as client:
        token = login(client, "Учитель", "teacher")["token"]
        response = client.post(
            "/api/upload",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": ("pixel.png", PNG_1X1, "image/png")},
        )
    assert response.status_code == 413
    assert "0 МБ" in response.json()["detail"]


def test_ws_message_over_limit_is_rejected(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")
    with client.websocket_connect(ws_url(teacher["token"])) as ws:
        ws.receive_json()
        ws.send_text(json.dumps({"type": "cursor", "x": 1, "y": 2, "pad": "x" * 300_000}))
        error = ws.receive_json()
    assert error["type"] == "error"
    assert error["code"] == "message_too_large"


def test_disconnect_during_stroke_finalizes_it(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with client.websocket_connect(ws_url(teacher["token"])) as ws:
        ws.receive_json()
        ws.send_json({**STROKE_START, "point": {"x": 10, "y": 10}})
        ws.send_json({"type": "stroke_point", "objectId": "stroke-1", "point": {"x": 60, "y": 40}})
        # Barrier: the error proves the points above were processed before closing.
        ws.send_json({"type": "bogus"})
        assert ws.receive_json()["code"] == "invalid_message"

    with client.websocket_connect(ws_url(teacher["token"])) as ws:
        init = ws.receive_json()
    assert [obj["id"] for obj in init["objects"]] == ["stroke-1"]
    assert len(init["objects"][0]["points"]) == 2


def test_two_students_can_draw_at_the_same_time(client: TestClient, login_user, ws_url) -> None:
    first = login_user("Первый", "student")
    second = login_user("Второй", "student")

    shape_template = {
        "type": "shape_add",
        "shapeType": "rect",
        "x": 10,
        "y": 20,
        "width": 80,
        "height": 40,
        "color": "#2563eb",
        "strokeWidth": 2,
    }

    with client.websocket_connect(ws_url(first["token"])) as first_ws:
        first_ws.receive_json()
        with client.websocket_connect(ws_url(second["token"])) as second_ws:
            second_ws.receive_json()
            first_ws.receive_json()

            first_ws.send_json({**shape_template, "objectId": "shape-first"})
            second_ws.send_json({**shape_template, "objectId": "shape-second"})

            got_second = second_ws.receive_json()
            got_first = first_ws.receive_json()

    assert got_second["object"]["id"] == "shape-first"
    assert got_first["object"]["id"] == "shape-second"


def test_invalid_transform_rotation_is_rejected(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with client.websocket_connect(ws_url(teacher["token"])) as ws:
        ws.receive_json()
        ws.send_json(
            {
                "type": "object_transform",
                "objectId": "shape-1",
                "x": 1,
                "y": 2,
                "rotation": 999,
            }
        )
        error = ws.receive_json()
    assert error["code"] == "invalid_message"


def test_empty_text_update_is_rejected(client: TestClient, login_user, ws_url) -> None:
    teacher = login_user("Учитель", "teacher")

    with client.websocket_connect(ws_url(teacher["token"])) as ws:
        ws.receive_json()
        ws.send_json({"type": "text_update", "objectId": "text-1", "content": ""})
        error = ws.receive_json()
    assert error["code"] == "invalid_message"
