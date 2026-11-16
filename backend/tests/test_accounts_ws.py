"""WebSocket authorization and room access tests."""

from __future__ import annotations

import asyncio

import pytest
from starlette.websockets import WebSocketDisconnect
from tests.support import cookie, login_session, ws_connect

PASSWORD = "secret-1"


def make_user(client, activate_user, login: str, *, role: str | None = None) -> str:
    response = client.post(
        "/api/register",
        json={"login": login, "name": login.title(), "password": PASSWORD},
    )
    assert response.status_code == 201, response.text
    activate_user(login, role=role)
    return login_session(client, login, PASSWORD)


def make_room(client, teacher_session: str, name: str = "Комната") -> dict:
    response = client.post("/api/rooms", json={"name": name}, cookies=cookie(teacher_session))
    assert response.status_code == 201, response.text
    return response.json()


def uid(client, session: str) -> str:
    return client.get("/api/me", cookies=cookie(session)).json()["user"]["id"]


def grant(client, teacher_session: str, room_id: str, student_id: str) -> None:
    response = client.put(
        f"/api/rooms/{room_id}/access",
        json={"userIds": [student_id]},
        cookies=cookie(teacher_session),
    )
    assert response.status_code == 200, response.text


def expect_close(ws, code: int) -> None:
    with pytest.raises(WebSocketDisconnect) as exc:
        ws.receive_json()
    assert exc.value.code == code


def test_ws_without_cookie_closes_4401(client) -> None:
    with ws_connect(client, "unknown-session", "r_missing") as ws:
        expect_close(ws, 4401)


def test_room_must_exist(client, activate_user) -> None:
    student = make_user(client, activate_user, "student-1")

    with ws_connect(client, student, "r_missing") as ws:
        expect_close(ws, 4404)


def test_pending_user_cannot_connect(client) -> None:
    client.post(
        "/api/register",
        json={"login": "pending", "name": "Пётр", "password": PASSWORD},
    )
    store = client.app.state.accounts
    pending = asyncio.run(store.get_user_by_login("pending"))
    session = asyncio.run(store.create_session(pending.id, 60))

    with ws_connect(client, session, "r_missing") as ws:
        expect_close(ws, 4401)


def test_student_without_grant_gets_4403_then_works_after_grant(client, activate_user) -> None:
    teacher = make_user(client, activate_user, "teacher-1", role="teacher")
    student = make_user(client, activate_user, "student-1")
    room = make_room(client, teacher)

    with ws_connect(client, student, room["id"]) as ws:
        expect_close(ws, 4403)

    grant(client, teacher, room["id"], uid(client, student))

    with ws_connect(client, student, room["id"]) as ws:
        init = ws.receive_json()
        assert init["type"] == "init"
        assert init["role"] == "student"
        assert init["workspaceId"] == "ws_default"

    with ws_connect(client, teacher, room["id"]) as ws:
        assert ws.receive_json()["role"] == "teacher"


def test_revoke_access_kicks_live_socket(client, activate_user) -> None:
    teacher = make_user(client, activate_user, "teacher-1", role="teacher")
    student = make_user(client, activate_user, "student-1")
    room = make_room(client, teacher)
    grant(client, teacher, room["id"], uid(client, student))

    with ws_connect(client, student, room["id"]) as ws:
        assert ws.receive_json()["type"] == "init"

        response = client.put(
            f"/api/rooms/{room['id']}/access",
            json={"userIds": []},
            cookies=cookie(teacher),
        )
        assert response.status_code == 200

        kicked = ws.receive_json()
        assert kicked == {
            "type": "kicked",
            "reason": "Учитель отменил доступ к комнате",
        }
        expect_close(ws, 4403)


def test_admin_joins_foreign_room_with_teacher_powers(client, activate_user, admin_session) -> None:
    teacher = make_user(client, activate_user, "teacher-1", role="teacher")
    room = make_room(client, teacher)

    with (
        ws_connect(client, teacher, room["id"]) as teacher_ws,
        ws_connect(client, admin_session, room["id"]) as admin_ws,
    ):
        assert teacher_ws.receive_json()["type"] == "init"
        admin_init = admin_ws.receive_json()
        assert admin_init["role"] == "admin"
        assert admin_init["permissions"]["canClear"] is True
        assert teacher_ws.receive_json()["type"] == "user_joined"

        admin_ws.send_json({"type": "clear"})
        assert teacher_ws.receive_json()["type"] == "clear"


def test_block_and_role_change_kick_live_socket(client, activate_user, admin_session) -> None:
    room_owner = make_user(client, activate_user, "teacher-1", role="teacher")
    room = make_room(client, room_owner)

    with ws_connect(client, room_owner, room["id"]) as ws:
        assert ws.receive_json()["type"] == "init"

        client.patch(
            f"/api/admin/users/{uid(client, room_owner)}",
            json={"role": "student"},
            cookies=cookie(admin_session),
        )

        kicked = ws.receive_json()
        assert kicked["type"] == "kicked"
        assert kicked["reason"] == "Ваша роль изменилась"
        expect_close(ws, 4403)

    # A demoted owner cannot re-enter their room (the old session was revoked).
    again = login_session(client, "teacher-1", PASSWORD)
    with ws_connect(client, again, room["id"]) as ws:
        expect_close(ws, 4403)


def test_block_kicks_live_socket(client, activate_user, admin_session) -> None:
    teacher = make_user(client, activate_user, "teacher-1", role="teacher")
    student = make_user(client, activate_user, "student-1")
    room = make_room(client, teacher)
    grant(client, teacher, room["id"], uid(client, student))

    with ws_connect(client, student, room["id"]) as ws:
        assert ws.receive_json()["type"] == "init"

        client.patch(
            f"/api/admin/users/{uid(client, student)}",
            json={"status": "blocked"},
            cookies=cookie(admin_session),
        )

        kicked = ws.receive_json()
        assert kicked["type"] == "kicked"
        assert kicked["reason"] == "Учётная запись заблокирована"
        expect_close(ws, 4403)
