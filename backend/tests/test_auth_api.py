"""Cookie-based registration, login and session tests."""

from __future__ import annotations

from app.models.schemas import permissions_for
from app.services.auth import WindowLimiter
from tests.support import login_session

PASSWORD = "secret-1"


def register(client, login: str, name: str = "Пользователь", password: str = PASSWORD):
    return client.post("/api/register", json={"login": login, "name": name, "password": password})


def test_register_creates_pending_and_login_is_forbidden(client) -> None:
    response = register(client, "Anna_1", "Анна")

    assert response.status_code == 201
    assert response.json() == {"status": "pending"}

    login = client.post("/api/login", json={"login": "anna_1", "password": PASSWORD})
    assert login.status_code == 403
    assert login.json()["detail"]["code"] == "pending"


def test_duplicate_login_is_case_insensitive(client) -> None:
    assert register(client, "anna").status_code == 201

    duplicate = register(client, "ANNA", "Другая")

    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "login_taken"


def test_activate_via_store_then_login_sets_cookie(client, activate_user) -> None:
    register(client, "anna", "Анна")
    activate_user("anna")

    response = client.post("/api/login", json={"login": "anna", "password": PASSWORD})

    assert response.status_code == 200
    set_cookie = response.headers["set-cookie"]
    assert "wb_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie
    body = response.json()
    assert body["user"]["login"] == "anna"
    assert body["user"]["role"] == "student"
    assert body["permissions"]["canManageAccounts"] is False
    assert body["board"]["width"] > 0

    me = client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["user"]["name"] == "Анна"


def test_logout_clears_session(client, activate_user) -> None:
    register(client, "anna")
    activate_user("anna")
    login_session(client, "anna", PASSWORD)

    assert client.post("/api/logout").status_code == 204
    assert client.get("/api/me").status_code == 401


def test_wrong_origin_is_rejected(client, activate_user) -> None:
    register(client, "anna")
    activate_user("anna")
    login_session(client, "anna", PASSWORD)

    response = client.post("/api/logout", headers={"Origin": "https://evil.example"})

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "bad_origin"


def test_wrong_password_and_login_throttle(client, app, activate_user) -> None:
    register(client, "anna")
    activate_user("anna")
    app.state.login_limiter = WindowLimiter(limit=2, window_seconds=60)

    first = client.post("/api/login", json={"login": "anna", "password": "wrong-one"})
    second = client.post("/api/login", json={"login": "anna", "password": "wrong-two"})
    third = client.post("/api/login", json={"login": "anna", "password": "wrong-3"})

    assert first.status_code == 401
    assert second.status_code == 401
    assert third.status_code == 429
    assert third.json()["detail"]["code"] == "rate_limited"


def test_admin_permissions_include_accounts() -> None:
    assert permissions_for("admin").canManageAccounts is True
    assert permissions_for("teacher").canManageAccounts is False
    assert permissions_for("teacher").canCreateRooms is True
    assert permissions_for("student").canCreateRooms is False
