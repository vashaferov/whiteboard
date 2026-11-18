"""Presentation workspace WebSocket behaviour and permissions."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from tests.support import cookie, ws_connect
from tests.test_board_elements import barrier, codes, recv_until

PDF = (Path(__file__).parent / "fixtures" / "two-slides.pdf").read_bytes()


def upload_presentation(client: TestClient, token: str) -> list[str]:
    response = client.post(
        "/api/presentations",
        cookies=cookie(token),
        files={"file": ("lesson.pdf", PDF, "application/pdf")},
    )
    assert response.status_code == 200, response.text
    return response.json()["slides"]


def create_presentation(websocket, slides: list[str]) -> dict:
    websocket.send_json(
        {
            "type": "workspace_create",
            "name": "Урок",
            "kind": "presentation",
            "slides": slides,
        }
    )
    workspace = recv_until(websocket, "workspace_created")["workspace"]
    recv_until(websocket, "workspace_state")
    return workspace


def stroke_start(websocket, object_id: str = "s0") -> None:
    websocket.send_json(
        {
            "type": "stroke_start",
            "objectId": object_id,
            "tool": "brush",
            "color": "#2563eb",
            "width": 4,
            "point": {"x": 10, "y": 10},
        }
    )


def finish_stroke(websocket, object_id: str = "s0") -> None:
    websocket.send_json({"type": "stroke_end", "objectId": object_id})


def test_presentation_slides_and_strokes(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    slides = upload_presentation(client, teacher["token"])

    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        workspace = create_presentation(tw, slides)
        created = recv_until(sw, "workspace_created")["workspace"]
        assert created["id"] == workspace["id"]
        assert created["kind"] == "presentation"
        assert created["slides"] == slides
        assert created["slideIndex"] == 0

        sw.send_json({"type": "workspace_switch", "workspaceId": workspace["id"]})
        switched = recv_until(sw, "workspace_state")
        assert switched["workspaceId"] == workspace["id"]
        assert switched["slideIndex"] == 0

        stroke_start(tw, "s0")
        assert recv_until(sw, "stroke_start")["object"]["slide"] == 0
        tw.send_json({"type": "stroke_point", "objectId": "s0", "point": {"x": 30, "y": 40}})
        recv_until(sw, "stroke_point")
        finish_stroke(tw, "s0")
        ended = recv_until(sw, "stroke_end")
        assert ended["object"]["slide"] == 0

        tw.send_json({"type": "presentation_slide", "slideIndex": 1})
        moved = recv_until(sw, "presentation_slide")
        assert moved["slideIndex"] == 1
        assert moved["objects"] == []
        assert recv_until(tw, "presentation_slide")["slideIndex"] == 1

        stroke_start(tw, "s1")
        recv_until(sw, "stroke_start")
        finish_stroke(tw, "s1")
        recv_until(sw, "stroke_end")

        tw.send_json({"type": "presentation_slide", "slideIndex": 0})
        back = recv_until(sw, "presentation_slide")
        assert back["slideIndex"] == 0
        assert [obj["id"] for obj in back["objects"]] == ["s0"]
        recv_until(tw, "presentation_slide")


def test_presentation_permissions(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    slides = upload_presentation(client, teacher["token"])

    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        workspace = create_presentation(tw, slides)
        recv_until(sw, "workspace_created")
        sw.send_json({"type": "workspace_switch", "workspaceId": workspace["id"]})
        recv_until(sw, "workspace_state")

        sw.send_json({"type": "presentation_slide", "slideIndex": 1})
        assert "forbidden" in codes(barrier(sw))
        stroke_start(sw, "student-stroke")
        assert "presentation_brush_only" in codes(barrier(sw))

        tw.send_json(
            {
                "type": "shape_add",
                "objectId": "shape-1",
                "shapeType": "rect",
                "x": 1,
                "y": 2,
                "width": 10,
                "height": 10,
                "color": "#2563eb",
                "strokeWidth": 4,
                "fill": None,
            }
        )
        assert "presentation_view_only" in codes(barrier(tw))
        tw.send_json({"type": "clear"})
        assert "presentation_view_only" in codes(barrier(tw))
        sw.send_json({"type": "undo"})
        assert "presentation_view_only" in codes(barrier(sw))

        sw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        assert recv_until(sw, "workspace_state")["workspaceId"] == "ws_default"


def test_presentation_undo_is_per_slide(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    slides = upload_presentation(client, teacher["token"])

    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)
        workspace = create_presentation(tw, slides)
        recv_until(sw, "workspace_created")
        sw.send_json({"type": "workspace_switch", "workspaceId": workspace["id"]})
        recv_until(sw, "workspace_state")

        stroke_start(tw, "s0")
        recv_until(sw, "stroke_start")
        finish_stroke(tw, "s0")
        recv_until(sw, "stroke_end")

        tw.send_json({"type": "presentation_slide", "slideIndex": 1})
        recv_until(sw, "presentation_slide")
        recv_until(tw, "presentation_slide")
        stroke_start(tw, "s1")
        recv_until(sw, "stroke_start")
        finish_stroke(tw, "s1")
        recv_until(sw, "stroke_end")

        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["s1"]
        assert recv_until(sw, "objects_restored")["removedIds"] == ["s1"]

        tw.send_json({"type": "presentation_slide", "slideIndex": 0})
        back = recv_until(sw, "presentation_slide")
        assert [obj["id"] for obj in back["objects"]] == ["s0"]
        recv_until(tw, "presentation_slide")

        tw.send_json({"type": "undo"})
        assert recv_until(tw, "objects_restored")["removedIds"] == ["s0"]
        assert recv_until(sw, "objects_restored")["removedIds"] == ["s0"]

        tw.send_json({"type": "undo"})
        assert "undo_empty" in codes(barrier(tw))

        sw.send_json({"type": "undo"})
        assert "presentation_view_only" in codes(barrier(sw))


def test_presentation_invalid_upload_url(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        tw.send_json(
            {
                "type": "workspace_create",
                "name": "Урок",
                "kind": "presentation",
                "slides": ["/uploads/missing.jpg"],
            }
        )
        assert "invalid_presentation" in codes(barrier(tw))
