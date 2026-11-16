"""Unit tests for the account/session store."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from app.services.accounts import AccountStore, LoginTakenError
from app.services.auth import WindowLimiter, hash_password, normalize_login, verify_password


@pytest.fixture
async def store(tmp_path: Path):
    instance = AccountStore(tmp_path / "whiteboard.db")
    try:
        yield instance
    finally:
        await instance.close()


def test_normalize_login() -> None:
    assert normalize_login("  Ann.A ") == "ann.a"


async def test_create_user_normalizes_login(store: AccountStore) -> None:
    user = await store.create_user(
        login=" Ann.A ",
        name="Анна",
        password_hash=hash_password("secret-1", 4),
    )

    assert user.login == "Ann.A"
    assert user.role == "student"
    assert user.status == "pending"
    assert user.color.startswith("#")
    fetched = await store.get_user_by_login("ann.a")
    assert fetched is not None and fetched.id == user.id


async def test_duplicate_login_raises(store: AccountStore) -> None:
    await store.create_user(login="ann", name="A", password_hash="x")

    with pytest.raises(LoginTakenError):
        await store.create_user(login="ANN", name="B", password_hash="x")


async def test_get_user_with_hash(store: AccountStore) -> None:
    digest = hash_password("secret-1", 4)
    user = await store.create_user(login="ann", name="A", password_hash=digest)

    found = await store.get_user_with_hash("ANN")
    assert found is not None
    stored_user, stored_hash = found
    assert stored_user.id == user.id
    assert verify_password("secret-1", stored_hash)


async def test_session_roundtrip_delete_and_expiry(store: AccountStore) -> None:
    user = await store.create_user(login="ann", name="A", password_hash="x", status="active")

    session_id = await store.create_session(user.id, ttl_seconds=60)
    fetched = await store.get_session_user(session_id)
    assert fetched is not None and fetched.id == user.id

    await store.delete_session(session_id)
    assert await store.get_session_user(session_id) is None

    expired = await store.create_session(user.id, ttl_seconds=-1)
    assert await store.get_session_user(expired) is None


async def test_prune_sessions_keeps_valid(store: AccountStore) -> None:
    user = await store.create_user(login="ann", name="A", password_hash="x", status="active")
    valid = await store.create_session(user.id, ttl_seconds=60)
    await store.create_session(user.id, ttl_seconds=-5)

    assert await store.prune_sessions() == 1
    assert await store.get_session_user(valid) is not None


async def test_delete_user_sessions(store: AccountStore) -> None:
    user = await store.create_user(login="ann", name="A", password_hash="x", status="active")
    first = await store.create_session(user.id, ttl_seconds=60)
    second = await store.create_session(user.id, ttl_seconds=60)

    await store.delete_user_sessions(user.id)

    assert await store.get_session_user(first) is None
    assert await store.get_session_user(second) is None


async def test_ensure_admin_only_once(store: AccountStore) -> None:
    created = await store.ensure_admin(login="root", name="Администратор", password_hash="x")
    assert created is not None
    assert created.role == "admin"
    assert created.status == "active"

    assert await store.ensure_admin(login="root2", name="Ещё", password_hash="x") is None


async def test_update_user_role_status_and_password(store: AccountStore) -> None:
    user = await store.create_user(login="ann", name="A", password_hash="old")

    updated = await store.update_user(user.id, status="active", role="teacher")
    assert updated is not None
    assert updated.status == "active" and updated.role == "teacher"

    assert await store.set_password(user.id, "new")
    found = await store.get_user_with_hash("ann")
    assert found is not None and found[1] == "new"


async def test_list_users_filters(store: AccountStore) -> None:
    await store.create_user(login="anna", name="Анна", password_hash="x", status="active")
    await store.create_user(login="boris", name="Борис", password_hash="x", status="pending")
    await store.create_user(
        login="vera", name="Вера", password_hash="x", status="active", role="teacher"
    )

    active_students = await store.list_users(status="active", role="student")
    assert [user.login for user in active_students] == ["anna"]

    found = await store.list_users(query="анн")
    assert [user.login for user in found] == ["anna"]


def test_password_hash_roundtrip() -> None:
    digest = hash_password("long-enough", 4)
    assert digest.startswith("$2")
    assert verify_password("long-enough", digest)
    assert not verify_password("wrong", digest)
    assert not verify_password("long-enough", "not-a-hash")


def test_window_limiter() -> None:
    limiter = WindowLimiter(limit=2, window_seconds=60)
    assert limiter.hit("ip") is True
    assert limiter.hit("ip") is True
    assert limiter.hit("ip") is False
    limiter.reset("ip")
    assert limiter.hit("ip") is True


def test_legacy_snapshots_wiped_once(tmp_path: Path) -> None:
    from app.services.storage import SnapshotStore

    database = tmp_path / "whiteboard.db"
    snapshots = SnapshotStore(database)
    asyncio.run(snapshots.save("old-room", [{"id": "o1"}], 1, []))

    first = AccountStore(database)
    assert first.legacy_wiped is True
    assert asyncio.run(snapshots.load("old-room")) is None

    second = AccountStore(database)
    assert second.legacy_wiped is False
