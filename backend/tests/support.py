"""Shared helpers for REST/WebSocket tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

ADMIN_LOGIN = "root"
ADMIN_PASSWORD = "root-pass-1"


def cookie(session: str) -> dict[str, str]:
    return {"wb_session": session}


def login_session(client: TestClient, login: str, password: str) -> str:
    response = client.post("/api/login", json={"login": login, "password": password})
    assert response.status_code == 200, response.text
    session = response.cookies.get("wb_session")
    assert session, "login did not set wb_session"
    return session


def ws_connect(client: TestClient, session: str, room: str = "room-1"):
    return client.websocket_connect(f"/ws/{room}", headers={"cookie": f"wb_session={session}"})
