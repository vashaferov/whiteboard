"""Unit tests for owned rooms and access grants."""

from __future__ import annotations

from pathlib import Path

import pytest
from app.services.accounts import AccountStore
from app.services.auth import hash_password


@pytest.fixture
async def store(tmp_path: Path):
    instance = AccountStore(tmp_path / "whiteboard.db")
    try:
        yield instance
    finally:
        await instance.close()


async def make_user(store: AccountStore, login: str, *, role: str = "student") -> str:
    user = await store.create_user(
        login=login,
        name=login.title(),
        password_hash=hash_password("secret-1", 4),
        role=role,
        status="active",
    )
    return user.id


async def test_create_and_get_room(store: AccountStore) -> None:
    owner_id = await make_user(store, "teacher", role="teacher")

    room = await store.create_room(owner_id=owner_id, name=" Алгебра ", room_id="r_test")
    assert room.id == "r_test"
    assert room.owner_id == owner_id
    assert room.owner_name == "Teacher"

    fetched = await store.get_room("r_test")
    assert fetched is not None
    assert fetched.name == "Алгебра"

    generated = await store.create_room(owner_id=owner_id, name="Геометрия")
    assert generated.id.startswith("r_")
    assert generated.id != "r_test"


async def test_rename_room(store: AccountStore) -> None:
    owner_id = await make_user(store, "teacher", role="teacher")
    await store.create_room(owner_id=owner_id, name="Старое", room_id="r_1")

    renamed = await store.rename_room("r_1", "Новое")
    assert renamed is not None and renamed.name == "Новое"
    assert (await store.get_room("r_1")).name == "Новое"
    assert await store.rename_room("nope", "x") is None


async def test_set_room_access_replaces_list(store: AccountStore) -> None:
    owner_id = await make_user(store, "teacher", role="teacher")
    first = await make_user(store, "first")
    second = await make_user(store, "second")
    await store.create_room(owner_id=owner_id, name="Комната", room_id="r_1")

    current, added, removed = await store.set_room_access(
        "r_1", [first, second], granted_by=owner_id
    )
    assert {user.id for user in current} == {first, second}
    assert added == {first, second} and removed == set()

    current, added, removed = await store.set_room_access("r_1", [second], granted_by=owner_id)
    assert [user.id for user in current] == [second]
    assert added == set() and removed == {first}
    assert await store.has_room_access("r_1", second) is True
    assert await store.has_room_access("r_1", first) is False


async def test_delete_room_removes_access(store: AccountStore) -> None:
    owner_id = await make_user(store, "teacher", role="teacher")
    student = await make_user(store, "student")
    await store.create_room(owner_id=owner_id, name="Комната", room_id="r_1")
    await store.set_room_access("r_1", [student], granted_by=owner_id)

    assert await store.delete_room("r_1") is True
    assert await store.get_room("r_1") is None
    assert await store.has_room_access("r_1", student) is False
    assert await store.delete_room("r_1") is False


async def test_lists_by_role(store: AccountStore) -> None:
    owner_id = await make_user(store, "teacher", role="teacher")
    student = await make_user(store, "student")
    await store.create_room(owner_id=owner_id, name="Первая", room_id="r_1")
    await store.create_room(owner_id=owner_id, name="Вторая", room_id="r_2")
    await store.set_room_access("r_2", [student], granted_by=owner_id)

    owned = await store.list_owned_rooms(owner_id)
    assert [room.id for room in owned] == ["r_1", "r_2"]
    granted = await store.list_rooms_for_student(student)
    assert [room.id for room in granted] == ["r_2"]
    assert {room.id for room in await store.list_all_rooms()} == {"r_1", "r_2"}
    assert set(await store.list_room_ids()) == {"r_1", "r_2"}


async def test_list_active_students(store: AccountStore) -> None:
    await make_user(store, "anna")
    await make_user(store, "boris")
    await store.create_user(
        login="pending",
        name="Пётр",
        password_hash="x",
        status="pending",
    )
    await make_user(store, "teacher", role="teacher")

    everyone = await store.list_active_students()
    assert {user.login for user in everyone} == {"anna", "boris"}

    found = await store.list_active_students("ann")
    assert [user.login for user in found] == ["anna"]
