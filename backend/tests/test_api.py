"""REST: health, login, upload."""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "rooms": 0, "users": 0}


def test_student_login(client: TestClient) -> None:
    response = client.post(
        "/api/login",
        json={"name": "  Анна  ", "roomId": "room-1", "role": "student"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["user"]["name"] == "Анна"
    assert data["user"]["role"] == "student"
    assert data["roomId"] == "room-1"
    assert data["board"] == {"width": 1600, "height": 900}
    assert data["permissions"] == {
        "canDraw": True,
        "canClear": False,
        "canDelete": False,
        "canManageUsers": False,
    }
    assert data["token"]


def test_teacher_login_requires_code(client: TestClient) -> None:
    payload = {"name": "Иван", "roomId": "room-1", "role": "teacher"}

    missing = client.post("/api/login", json=payload)
    assert missing.status_code == 403

    wrong = client.post("/api/login", json={**payload, "code": "nope"})
    assert wrong.status_code == 403

    ok = client.post("/api/login", json={**payload, "code": "secret-code"})
    assert ok.status_code == 200
    assert ok.json()["permissions"]["canClear"] is True


def test_login_validation(client: TestClient) -> None:
    assert (
        client.post(
            "/api/login", json={"name": "", "roomId": "room-1", "role": "student"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/login", json={"name": "A", "roomId": "bad room!", "role": "student"}
        ).status_code
        == 422
    )


def test_upload_requires_token(client: TestClient) -> None:
    response = client.post(
        "/api/upload",
        files={"file": ("pixel.png", PNG_1X1, "image/png")},
    )
    assert response.status_code == 401


def test_upload_rejects_bad_payload(client: TestClient, login_user) -> None:
    token = login_user()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    unsupported = client.post(
        "/api/upload",
        headers=headers,
        files={"file": ("doc.svg", b"<svg></svg>", "image/svg+xml")},
    )
    assert unsupported.status_code == 415

    corrupted = client.post(
        "/api/upload",
        headers=headers,
        files={"file": ("fake.png", b"not a png", "image/png")},
    )
    assert corrupted.status_code == 415


def test_upload_saves_file(client: TestClient, login_user, settings) -> None:
    token = login_user()["token"]
    response = client.post(
        "/api/upload",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("pixel.png", PNG_1X1, "image/png")},
    )
    assert response.status_code == 200, response.text
    url = response.json()["url"]
    assert url.startswith("/uploads/")
    assert (settings.uploads_dir / url.removeprefix("/uploads/")).is_file()

    served = client.get(url)
    assert served.status_code == 200
