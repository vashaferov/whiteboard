"""Режим холста страницы."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def test_workspace_canvas_defaults_to_infinite(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        init = tw.receive_json()
        assert "canvas" not in init["workspaces"][0]
        barrier(tw)

        tw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 1200, "height": 800})
        changed = recv_until(tw, "workspace_canvas")
        assert changed["canvas"] == {"mode": "fixed", "width": 1200, "height": 800}

        tw.send_json({"type": "workspace_canvas", "mode": "infinite"})
        assert recv_until(tw, "workspace_canvas")["canvas"] is None


def test_workspace_canvas_permissions_and_validation(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        sw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 900, "height": 700})
        assert codes(barrier(sw)) == ["forbidden"]

        tw.send_json({"type": "workspace_canvas", "mode": "fixed"})
        assert recv_until(tw, "error")["code"] == "invalid_message"
        tw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 4000, "height": 500})
        assert recv_until(tw, "error")["code"] == "invalid_message"


def test_workspace_canvas_is_per_page(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json({"type": "workspace_canvas", "mode": "fixed", "width": 1200, "height": 800})
        recv_until(tw, "workspace_canvas")

        tw.send_json({"type": "workspace_create", "name": "Вторая"})
        second = recv_until(tw, "workspace_created")["workspace"]
        recv_until(tw, "workspace_state")
        assert "canvas" not in second

        tw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        state = recv_until(tw, "workspace_state")
        assert state["canvas"] == {"mode": "fixed", "width": 1200, "height": 800}
