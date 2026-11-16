"""Access rules for rooms."""

from __future__ import annotations

import pytest
from app.services.access import can_access_room
from app.services.accounts import Room, User


def make_user(role: str, user_id: str = "u_1") -> User:
    return User(
        id=user_id,
        login="user",
        name="User",
        role=role,
        status="active",
        color="#2563eb",
        created_at="2026-01-01T00:00:00+00:00",
    )


def make_room(owner_id: str) -> Room:
    return Room(
        id="r_1",
        name="Комната",
        owner_id=owner_id,
        owner_name="Owner",
        created_at="2026-01-01T00:00:00+00:00",
    )


@pytest.mark.parametrize(
    ("role", "is_owner", "granted", "expected"),
    [
        ("admin", False, False, True),
        ("admin", False, True, True),
        ("teacher", True, False, True),
        ("teacher", False, True, True),
        ("teacher", False, False, False),
        ("student", True, False, False),
        ("student", False, True, True),
        ("student", False, False, False),
    ],
)
def test_can_access_room(role: str, is_owner: bool, granted: bool, expected: bool) -> None:
    user = make_user(role)
    room = make_room(owner_id=user.id if is_owner else "u_other")

    assert can_access_room(user, room, granted=granted) is expected
