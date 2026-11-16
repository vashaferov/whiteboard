"""Room access rules shared by REST and WebSocket layers."""

from __future__ import annotations

from app.services.accounts import Room, User


def can_access_room(user: User, room: Room, *, granted: bool) -> bool:
    """Return whether ``user`` may join ``room``.

    Admins may enter any room, a teacher owns only their own rooms, and any
    other user needs an explicit access grant.
    """

    if user.role == "admin":
        return True
    if user.role == "teacher" and room.owner_id == user.id:
        return True
    return granted
