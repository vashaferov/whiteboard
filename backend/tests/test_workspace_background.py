"""Цвет холста страницы."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def test_workspace_background_syncs_and_persists(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        tw.send_json({"type": "workspace_background", "color": "#123ABC"})
        assert recv_until(tw, "workspace_background")["color"] == "#123abc"
        assert recv_until(sw, "workspace_background")["color"] == "#123abc"

        tw.send_json({"type": "workspace_create", "name": "Вторая"})
        second = recv_until(tw, "workspace_created")["workspace"]
        recv_until(tw, "workspace_state")
        assert "background" not in second

        tw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        assert recv_until(tw, "workspace_state")["background"] == "#123abc"


def test_workspace_background_permissions_and_validation(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    with ws_connect(client, teacher["token"]) as tw, ws_connect(client, student["token"]) as sw:
        tw.receive_json()
        sw.receive_json()
        barrier(tw)

        sw.send_json({"type": "workspace_background", "color": "#abcdef"})
        assert codes(barrier(sw)) == ["forbidden"]

        tw.send_json({"type": "workspace_background", "color": "red"})
        assert recv_until(tw, "error")["code"] == "invalid_message"


def test_workspace_background_reset(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)

        tw.send_json({"type": "workspace_background", "color": "#123abc"})
        recv_until(tw, "workspace_background")
        tw.send_json({"type": "workspace_background", "color": None})
        assert recv_until(tw, "workspace_background")["color"] is None

        tw.send_json({"type": "workspace_create", "name": "Вторая"})
        recv_until(tw, "workspace_created")
        recv_until(tw, "workspace_state")
        tw.send_json({"type": "workspace_switch", "workspaceId": "ws_default"})
        assert "background" not in recv_until(tw, "workspace_state")
