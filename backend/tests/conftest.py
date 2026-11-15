"""Общие фикстуры для тестов."""

from __future__ import annotations

import sys
import urllib.parse
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

TEACHER_CODE = "secret-code"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        jwt_secret="test-secret-0123456789abcdef0123456789",
        teacher_code=TEACHER_CODE,
        data_dir=tmp_path / "data",
        uploads_dir=tmp_path / "uploads",
        frontend_dir=tmp_path / "frontend",
        snapshot_interval_seconds=0.01,
    )


@pytest.fixture
def app(settings: Settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def login_user(client: TestClient):
    def _login(
        name: str = "Анна",
        role: str = "student",
        room: str = "room-1",
        code: str | None = None,
    ) -> dict:
        payload: dict[str, str] = {"name": name, "roomId": room, "role": role}
        if role == "teacher":
            payload["code"] = TEACHER_CODE if code is None else code
        response = client.post("/api/login", json=payload)
        assert response.status_code == 200, response.text
        return response.json()

    return _login


@pytest.fixture
def ws_url():
    def _url(token: str, room: str = "room-1") -> str:
        return f"/ws/{room}?token={urllib.parse.quote(token)}"

    return _url
