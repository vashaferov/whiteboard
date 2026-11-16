"""Shared helpers for REST/WebSocket tests."""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

ADMIN_LOGIN = "root"
ADMIN_PASSWORD = "root-pass-1"
DEFAULT_PASSWORD = "secret-1"


def cookie(session: str) -> dict[str, str]:
    return {"wb_session": session}


def login_session(client: TestClient, login: str, password: str = DEFAULT_PASSWORD) -> str:
    response = client.post("/api/login", json={"login": login, "password": password})
    assert response.status_code == 200, response.text
    session = response.cookies.get("wb_session")
    assert session, "login did not set wb_session"
    return session


def make_active_account(
    client: TestClient,
    login: str,
    name: str,
    *,
    role: str | None = None,
    password: str = DEFAULT_PASSWORD,
) -> str:
    """Register, approve and optionally promote an account; return its id."""
    response = client.post(
        "/api/register", json={"login": login, "name": name, "password": password}
    )
    assert response.status_code == 201, response.text
    store = client.app.state.accounts
    user = asyncio.run(store.get_user_by_login(login))
    assert user is not None
    updates: dict[str, str] = {"status": "active"}
    if role is not None:
        updates["role"] = role
    asyncio.run(store.update_user(user.id, **updates))
    return user.id


def ensure_room(client: TestClient, room_id: str, owner_id: str, user_id: str) -> None:
    """Create the room with an explicit id and grant access when needed."""
    store = client.app.state.accounts
    room = asyncio.run(store.get_room(room_id))
    if room is None:
        room = asyncio.run(store.create_room(owner_id=owner_id, name=room_id, room_id=room_id))
    if room.owner_id != user_id:
        granted = [item.id for item in asyncio.run(store.list_room_access(room_id))]
        asyncio.run(store.set_room_access(room_id, [*granted, user_id], granted_by=room.owner_id))


def ensure_test_room(client: TestClient, room_id: str, user_id: str, role: str) -> None:
    """Room for a fixture user: teacher owns it, students get access via an admin."""
    store = client.app.state.accounts
    admin = asyncio.run(store.get_user_by_login(ADMIN_LOGIN))
    assert admin is not None
    owner_id = user_id if role == "teacher" else admin.id
    ensure_room(client, room_id, owner_id, user_id)


def ws_connect(client: TestClient, session: str, room: str = "room-1"):
    return client.websocket_connect(f"/ws/{room}", headers={"cookie": f"wb_session={session}"})
