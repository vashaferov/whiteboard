"""REST: health, login, upload."""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient
from tests.support import cookie

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "rooms": 0, "users": 0}


def test_student_login(client: TestClient, activate_user) -> None:
    registered = client.post(
        "/api/register",
        json={"login": "anna_login", "name": "  Анна  ", "password": "secret-1"},
    )
    assert registered.status_code == 201
    activate_user("anna_login")

    response = client.post("/api/login", json={"login": "anna_login", "password": "secret-1"})
    assert response.status_code == 200
    data = response.json()
    assert data["user"]["name"] == "Анна"
    assert data["user"]["login"] == "anna_login"
    assert data["user"]["role"] == "student"
    assert data["board"] == {"width": 1600, "height": 900}
    assert data["permissions"] == {
        "canDraw": True,
        "canClear": False,
        "canDelete": False,
        "canManageUsers": False,
        "canManageWorkspaces": False,
        "canCreateRooms": False,
        "canManageAccounts": False,
    }
    assert "wb_session" in response.cookies


def test_login_validation(client: TestClient) -> None:
    assert client.post("/api/login", json={"login": "", "password": ""}).status_code == 422
    legacy = {"name": "A", "roomId": "room-1", "role": "student"}
    assert client.post("/api/login", json=legacy).status_code == 422


def test_upload_requires_session(client: TestClient) -> None:
    response = client.post(
        "/api/upload",
        files={"file": ("pixel.png", PNG_1X1, "image/png")},
    )
    assert response.status_code == 401


def test_upload_rejects_bad_payload(client: TestClient, login_user) -> None:
    token = login_user()["token"]
    headers = cookie(token)

    unsupported = client.post(
        "/api/upload",
        cookies=headers,
        files={"file": ("doc.svg", b"<svg></svg>", "image/svg+xml")},
    )
    assert unsupported.status_code == 415

    corrupted = client.post(
        "/api/upload",
        cookies=headers,
        files={"file": ("fake.png", b"not a png", "image/png")},
    )
    assert corrupted.status_code == 415


def test_upload_saves_file(client: TestClient, login_user, settings) -> None:
    token = login_user()["token"]
    response = client.post(
        "/api/upload",
        cookies=cookie(token),
        files={"file": ("pixel.png", PNG_1X1, "image/png")},
    )
    assert response.status_code == 200, response.text
    url = response.json()["url"]
    assert url.startswith("/uploads/")
    assert (settings.uploads_dir / url.removeprefix("/uploads/")).is_file()

    served = client.get(url)
    assert served.status_code == 200
