"""Admin user management API tests."""

from __future__ import annotations

from tests.support import cookie, login_session

PASSWORD = "secret-1"


def register(client, login: str, name: str | None = None):
    return client.post(
        "/api/register",
        json={"login": login, "name": name or login.title(), "password": PASSWORD},
    )


def user_id(client, session: str) -> str:
    return client.get("/api/me", cookies=cookie(session)).json()["user"]["id"]


def find_user(client, admin: str, login: str) -> dict:
    response = client.get(f"/api/admin/users?q={login}", cookies=cookie(admin))
    assert response.status_code == 200, response.text
    return next(item for item in response.json() if item["login"] == login)


def test_only_admin_can_manage_users(client, activate_user, admin_session) -> None:
    register(client, "teacher", "Учитель")
    activate_user("teacher", role="teacher")
    teacher = login_session(client, "teacher", PASSWORD)

    assert client.get("/api/admin/users", cookies=cookie(teacher)).status_code == 403
    assert client.get("/api/admin/users", cookies=cookie(admin_session)).status_code == 200


def test_approve_promote_and_block(client, activate_user, admin_session) -> None:
    register(client, "anna", "Анна")
    pending = find_user(client, admin_session, "anna")
    assert pending["status"] == "pending"

    approved = client.patch(
        f"/api/admin/users/{pending['id']}",
        json={"status": "active"},
        cookies=cookie(admin_session),
    )
    assert approved.status_code == 200
    assert approved.json()["status"] == "active"
    assert login_session(client, "anna", PASSWORD)

    promoted = client.patch(
        f"/api/admin/users/{pending['id']}",
        json={"role": "teacher"},
        cookies=cookie(admin_session),
    )
    assert promoted.json()["role"] == "teacher"

    blocked = client.patch(
        f"/api/admin/users/{pending['id']}",
        json={"status": "blocked"},
        cookies=cookie(admin_session),
    )
    assert blocked.json()["status"] == "blocked"
    denied = client.post("/api/login", json={"login": "anna", "password": PASSWORD})
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "blocked"


def test_block_revokes_sessions(client, activate_user, admin_session) -> None:
    register(client, "anna")
    activate_user("anna")
    student = login_session(client, "anna", PASSWORD)
    target = find_user(client, admin_session, "anna")

    assert client.get("/api/me", cookies=cookie(student)).status_code == 200
    client.patch(
        f"/api/admin/users/{target['id']}",
        json={"status": "blocked"},
        cookies=cookie(admin_session),
    )

    assert client.get("/api/me", cookies=cookie(student)).status_code == 401


def test_password_reset_revokes_sessions(client, activate_user, admin_session) -> None:
    register(client, "anna")
    activate_user("anna")
    student = login_session(client, "anna", PASSWORD)
    target = find_user(client, admin_session, "anna")

    reset = client.post(
        f"/api/admin/users/{target['id']}/password",
        json={"password": "brand-new-1"},
        cookies=cookie(admin_session),
    )
    assert reset.status_code == 204

    assert client.get("/api/me", cookies=cookie(student)).status_code == 401
    old = client.post("/api/login", json={"login": "anna", "password": PASSWORD})
    assert old.status_code == 401
    assert login_session(client, "anna", "brand-new-1")


def test_admin_is_protected(client, admin_session) -> None:
    admin_id = user_id(client, admin_session)

    blocked = client.patch(
        f"/api/admin/users/{admin_id}",
        json={"status": "blocked"},
        cookies=cookie(admin_session),
    )
    assert blocked.status_code == 400
    assert blocked.json()["detail"]["code"] == "last_admin"

    demoted = client.patch(
        f"/api/admin/users/{admin_id}",
        json={"role": "student"},
        cookies=cookie(admin_session),
    )
    assert demoted.status_code == 400


def test_list_puts_pending_first(client, activate_user, admin_session) -> None:
    register(client, "active-one", "Активный")
    activate_user("active-one")
    register(client, "pending-one", "Ожидает")

    listed = client.get("/api/admin/users", cookies=cookie(admin_session)).json()
    logins = [item["login"] for item in listed]
    assert logins.index("pending-one") < logins.index("active-one")


def test_patch_requires_at_least_one_field(client, admin_session) -> None:
    register(client, "anna")
    target = find_user(client, admin_session, "anna")

    response = client.patch(
        f"/api/admin/users/{target['id']}", json={}, cookies=cookie(admin_session)
    )
    assert response.status_code == 422
