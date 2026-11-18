"""Невидимость администратора."""

from __future__ import annotations

from fastapi.testclient import TestClient
from tests.support import ws_connect
from tests.test_board_elements import barrier, codes, recv_until


def last_roster(messages: list[dict]) -> dict:
    rosters = [message for message in messages if message["type"] == "users_state"]
    assert rosters, messages
    return rosters[-1]


def ids(roster: dict) -> list[str]:
    return [user["id"] for user in roster["users"]]


def test_hidden_admin_is_absent_for_student(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    admin = login_user("Администратор", "admin")

    with (
        ws_connect(client, teacher["token"]) as tw,
        ws_connect(client, student["token"]) as sw,
        ws_connect(client, admin["token"]) as aw,
    ):
        tw.receive_json()
        student_init = sw.receive_json()
        admin_init = aw.receive_json()

        assert admin["user"]["id"] not in [user["id"] for user in student_init["users"]]
        assert admin_init["invisible"] is True

        assert any(
            message["type"] == "user_joined" and message["user"]["id"] == admin["user"]["id"]
            for message in barrier(tw)
        )
        assert not any(
            message["type"] == "user_joined" and message["user"]["id"] == admin["user"]["id"]
            for message in barrier(sw)
        )

        aw.send_json({"type": "set_invisible", "invisible": False})
        assert admin["user"]["id"] in ids(last_roster(barrier(sw)))

        aw.send_json({"type": "set_invisible", "invisible": True})
        assert admin["user"]["id"] not in ids(last_roster(barrier(sw)))


def test_only_admin_can_toggle_visibility(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    with ws_connect(client, teacher["token"]) as tw:
        tw.receive_json()
        barrier(tw)
        tw.send_json({"type": "set_invisible", "invisible": False})
        assert codes(barrier(tw)) == ["forbidden"]


def test_hidden_admin_cursor_is_private(client: TestClient, login_user) -> None:
    teacher = login_user("Учитель", "teacher")
    student = login_user("Ученик", "student")
    admin = login_user("Администратор", "admin")
    with (
        ws_connect(client, teacher["token"]) as tw,
        ws_connect(client, student["token"]) as sw,
        ws_connect(client, admin["token"]) as aw,
    ):
        tw.receive_json()
        sw.receive_json()
        aw.receive_json()
        barrier(tw)
        barrier(sw)

        aw.send_json({"type": "cursor", "workspaceId": "ws_default", "x": 10, "y": 20})
        assert [m for m in barrier(sw) if m["type"] == "cursor"] == []

        aw.send_json({"type": "set_invisible", "invisible": False})
        last_roster(barrier(sw))
        aw.send_json({"type": "cursor", "workspaceId": "ws_default", "x": 30, "y": 40})
        assert recv_until(sw, "cursor")["id"] == admin["user"]["id"]
