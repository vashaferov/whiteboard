"""SQLite-backed accounts and server-side sessions."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.services.auth import new_session_id, normalize_login, pick_color

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    login         TEXT NOT NULL,
    login_norm    TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'student'
                  CHECK (role IN ('student','teacher','admin')),
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','blocked','rejected')),
    color         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_owner_idx ON rooms(owner_id);

CREATE TABLE IF NOT EXISTS room_access (
    room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_USER_COLUMNS = "id, login, name, role, status, color, created_at"


class LoginTakenError(Exception):
    """Raised when a login is already registered (case-insensitive)."""


@dataclass(frozen=True, slots=True)
class User:
    id: str
    login: str
    name: str
    role: str
    status: str
    color: str
    created_at: str


@dataclass(frozen=True, slots=True)
class Room:
    id: str
    name: str
    owner_id: str
    owner_name: str
    created_at: str


_ROOM_SELECT = """
SELECT rooms.id, rooms.name, rooms.owner_id, users.name AS owner_name, rooms.created_at
FROM rooms
JOIN users ON users.id = rooms.owner_id
"""


def _row_to_room(row: sqlite3.Row) -> Room:
    return Room(
        id=str(row["id"]),
        name=str(row["name"]),
        owner_id=str(row["owner_id"]),
        owner_name=str(row["owner_name"]),
        created_at=str(row["created_at"]),
    )


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _row_to_user(row: sqlite3.Row) -> User:
    return User(
        id=str(row["id"]),
        login=str(row["login"]),
        name=str(row["name"]),
        role=str(row["role"]),
        status=str(row["status"]),
        color=str(row["color"]),
        created_at=str(row["created_at"]),
    )


class AccountStore:
    """Stores users and sessions in SQLite.

    Blocking work is pushed to worker threads so the event loop stays free.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.legacy_wiped = False
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate_legacy(conn)

    def _migrate_legacy(self, conn: sqlite3.Connection) -> None:
        """Wipe pre-accounts room snapshots exactly once."""
        marker = conn.execute("SELECT value FROM app_meta WHERE key = 'accounts_v1'").fetchone()
        if marker is not None:
            return
        tables = {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "room_snapshots" in tables:
            conn.execute("DELETE FROM room_snapshots")
        conn.execute("INSERT INTO app_meta (key, value) VALUES ('accounts_v1', ?)", (_now(),))
        self.legacy_wiped = True

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    # ------------------------------------------------------------------ users

    async def create_user(
        self,
        *,
        login: str,
        name: str,
        password_hash: str,
        role: str = "student",
        status: str = "pending",
        user_id: str | None = None,
    ) -> User:
        return await asyncio.to_thread(
            self._create_user_sync,
            login,
            name,
            password_hash,
            role,
            status,
            user_id,
        )

    def _create_user_sync(
        self,
        login: str,
        name: str,
        password_hash: str,
        role: str,
        status: str,
        user_id: str | None,
    ) -> User:
        cleaned = login.strip()
        if user_id is None:
            user_id = f"u_{uuid.uuid4().hex[:16]}"
        now = _now()
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO users
                        (id, login, login_norm, name, password_hash, role, status,
                         color, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        cleaned,
                        normalize_login(cleaned),
                        name,
                        password_hash,
                        role,
                        status,
                        pick_color(user_id),
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise LoginTakenError(cleaned) from exc
        user = self._get_user_sync(user_id)
        assert user is not None
        return user

    async def get_user(self, user_id: str) -> User | None:
        return await asyncio.to_thread(self._get_user_sync, user_id)

    def _get_user_sync(self, user_id: str) -> User | None:
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return _row_to_user(row) if row is not None else None

    async def get_user_by_login(self, login: str) -> User | None:
        return await asyncio.to_thread(self._get_user_by_login_sync, login)

    def _get_user_by_login_sync(self, login: str) -> User | None:
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users WHERE login_norm = ?",
                (normalize_login(login),),
            ).fetchone()
        return _row_to_user(row) if row is not None else None

    async def get_user_with_hash(self, login: str) -> tuple[User, str] | None:
        return await asyncio.to_thread(self._get_user_with_hash_sync, login)

    def _get_user_with_hash_sync(self, login: str) -> tuple[User, str] | None:
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT {_USER_COLUMNS}, password_hash FROM users WHERE login_norm = ?",
                (normalize_login(login),),
            ).fetchone()
        if row is None:
            return None
        return _row_to_user(row), str(row["password_hash"])

    async def list_users(
        self,
        *,
        status: str | None = None,
        role: str | None = None,
        query: str | None = None,
        limit: int = 500,
    ) -> list[User]:
        return await asyncio.to_thread(self._list_users_sync, status, role, query, limit)

    def _list_users_sync(
        self,
        status: str | None,
        role: str | None,
        query: str | None,
        limit: int,
    ) -> list[User]:
        clauses: list[str] = []
        params: list[Any] = []
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if role is not None:
            clauses.append("role = ?")
            params.append(role)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users{where} ORDER BY created_at, login",
                params,
            ).fetchall()
        users = [_row_to_user(row) for row in rows]
        if query:
            needle = query.strip().lower()
            if needle:
                users = [
                    user
                    for user in users
                    if needle in user.name.lower() or needle in user.login.lower()
                ]
        return users[:limit]

    async def update_user(
        self,
        user_id: str,
        *,
        status: str | None = None,
        role: str | None = None,
    ) -> User | None:
        return await asyncio.to_thread(self._update_user_sync, user_id, status, role)

    def _update_user_sync(self, user_id: str, status: str | None, role: str | None) -> User | None:
        fields: list[str] = []
        params: list[Any] = []
        if status is not None:
            fields.append("status = ?")
            params.append(status)
        if role is not None:
            fields.append("role = ?")
            params.append(role)
        if not fields:
            return self._get_user_sync(user_id)
        fields.append("updated_at = ?")
        params.append(_now())
        params.append(user_id)
        with self._connect() as conn:
            cursor = conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", params)
        if cursor.rowcount == 0:
            return None
        return self._get_user_sync(user_id)

    async def set_password(self, user_id: str, password_hash: str) -> bool:
        return await asyncio.to_thread(self._set_password_sync, user_id, password_hash)

    def _set_password_sync(self, user_id: str, password_hash: str) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                (password_hash, _now(), user_id),
            )
        return cursor.rowcount > 0

    async def ensure_admin(self, *, login: str, name: str, password_hash: str) -> User | None:
        return await asyncio.to_thread(self._ensure_admin_sync, login, name, password_hash)

    def _ensure_admin_sync(self, login: str, name: str, password_hash: str) -> User | None:
        cleaned = login.strip()
        user_id = f"u_{uuid.uuid4().hex[:16]}"
        now = _now()
        try:
            with self._connect() as conn:
                cursor = conn.execute(
                    """
                    INSERT INTO users
                        (id, login, login_norm, name, password_hash, role, status,
                         color, created_at, updated_at)
                    SELECT ?, ?, ?, ?, ?, 'admin', 'active', ?, ?, ?
                    WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
                    """,
                    (
                        user_id,
                        cleaned,
                        normalize_login(cleaned),
                        name,
                        password_hash,
                        pick_color(user_id),
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError:
            logger.warning("Bootstrap admin login %s is already taken", cleaned)
            return None
        if cursor.rowcount == 0:
            return None
        return self._get_user_sync(user_id)

    # ------------------------------------------------------------------ rooms

    async def create_room(self, *, owner_id: str, name: str, room_id: str | None = None) -> Room:
        return await asyncio.to_thread(self._create_room_sync, owner_id, name, room_id)

    def _create_room_sync(self, owner_id: str, name: str, room_id: str | None) -> Room:
        if room_id is None:
            room_id = f"r_{uuid.uuid4().hex[:16]}"
        now = _now()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO rooms (id, name, owner_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (room_id, name.strip(), owner_id, now, now),
            )
        room = self._get_room_sync(room_id)
        assert room is not None
        return room

    async def get_room(self, room_id: str) -> Room | None:
        return await asyncio.to_thread(self._get_room_sync, room_id)

    def _get_room_sync(self, room_id: str) -> Room | None:
        with self._connect() as conn:
            row = conn.execute(f"{_ROOM_SELECT} WHERE rooms.id = ?", (room_id,)).fetchone()
        return _row_to_room(row) if row is not None else None

    async def list_owned_rooms(self, owner_id: str) -> list[Room]:
        return await asyncio.to_thread(self._list_owned_rooms_sync, owner_id)

    def _list_owned_rooms_sync(self, owner_id: str) -> list[Room]:
        with self._connect() as conn:
            rows = conn.execute(
                f"{_ROOM_SELECT} WHERE rooms.owner_id = ? " "ORDER BY rooms.created_at, rooms.id",
                (owner_id,),
            ).fetchall()
        return [_row_to_room(row) for row in rows]

    async def list_rooms_for_student(self, user_id: str) -> list[Room]:
        return await asyncio.to_thread(self._list_rooms_for_student_sync, user_id)

    def _list_rooms_for_student_sync(self, user_id: str) -> list[Room]:
        with self._connect() as conn:
            rows = conn.execute(
                f"{_ROOM_SELECT} JOIN room_access ON room_access.room_id = rooms.id "
                "WHERE room_access.user_id = ? ORDER BY rooms.created_at, rooms.id",
                (user_id,),
            ).fetchall()
        return [_row_to_room(row) for row in rows]

    async def list_all_rooms(self) -> list[Room]:
        return await asyncio.to_thread(self._list_all_rooms_sync)

    def _list_all_rooms_sync(self) -> list[Room]:
        with self._connect() as conn:
            rows = conn.execute(f"{_ROOM_SELECT} ORDER BY rooms.created_at, rooms.id").fetchall()
        return [_row_to_room(row) for row in rows]

    async def list_room_ids(self) -> list[str]:
        return await asyncio.to_thread(self._list_room_ids_sync)

    def _list_room_ids_sync(self) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT id FROM rooms ORDER BY id").fetchall()
        return [str(row[0]) for row in rows]

    async def rename_room(self, room_id: str, name: str) -> Room | None:
        return await asyncio.to_thread(self._rename_room_sync, room_id, name)

    def _rename_room_sync(self, room_id: str, name: str) -> Room | None:
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE rooms SET name = ?, updated_at = ? WHERE id = ?",
                (name.strip(), _now(), room_id),
            )
        if cursor.rowcount == 0:
            return None
        return self._get_room_sync(room_id)

    async def delete_room(self, room_id: str) -> bool:
        return await asyncio.to_thread(self._delete_room_sync, room_id)

    def _delete_room_sync(self, room_id: str) -> bool:
        with self._connect() as conn:
            conn.execute("DELETE FROM room_access WHERE room_id = ?", (room_id,))
            cursor = conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
        return cursor.rowcount > 0

    async def list_room_access(self, room_id: str) -> list[User]:
        return await asyncio.to_thread(self._list_room_access_sync, room_id)

    def _room_access_rows(self, conn: sqlite3.Connection, room_id: str) -> list[sqlite3.Row]:
        return conn.execute(
            """
            SELECT users.id, users.login, users.name, users.role, users.status,
                   users.color, users.created_at
            FROM room_access
            JOIN users ON users.id = room_access.user_id
            WHERE room_access.room_id = ?
            ORDER BY users.login
            """,
            (room_id,),
        ).fetchall()

    def _list_room_access_sync(self, room_id: str) -> list[User]:
        with self._connect() as conn:
            rows = self._room_access_rows(conn, room_id)
        return [_row_to_user(row) for row in rows]

    async def set_room_access(
        self, room_id: str, user_ids: list[str], granted_by: str
    ) -> tuple[list[User], set[str], set[str]]:
        return await asyncio.to_thread(self._set_room_access_sync, room_id, user_ids, granted_by)

    def _set_room_access_sync(
        self, room_id: str, user_ids: list[str], granted_by: str
    ) -> tuple[list[User], set[str], set[str]]:
        desired = set(user_ids)
        now = _now()
        with self._connect() as conn:
            existing = {
                str(row[0])
                for row in conn.execute(
                    "SELECT user_id FROM room_access WHERE room_id = ?", (room_id,)
                )
            }
            added = desired - existing
            removed = existing - desired
            for user_id in added:
                conn.execute(
                    "INSERT OR IGNORE INTO room_access "
                    "(room_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)",
                    (room_id, user_id, granted_by, now),
                )
            for user_id in removed:
                conn.execute(
                    "DELETE FROM room_access WHERE room_id = ? AND user_id = ?",
                    (room_id, user_id),
                )
            rows = self._room_access_rows(conn, room_id)
        return [_row_to_user(row) for row in rows], added, removed

    async def has_room_access(self, room_id: str, user_id: str) -> bool:
        return await asyncio.to_thread(self._has_room_access_sync, room_id, user_id)

    def _has_room_access_sync(self, room_id: str, user_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM room_access WHERE room_id = ? AND user_id = ?",
                (room_id, user_id),
            ).fetchone()
        return row is not None

    async def list_active_students(self, query: str | None = None, limit: int = 50) -> list[User]:
        return await self.list_users(status="active", role="student", query=query, limit=limit)

    # --------------------------------------------------------------- sessions

    async def create_session(self, user_id: str, ttl_seconds: int) -> str:
        return await asyncio.to_thread(self._create_session_sync, user_id, ttl_seconds)

    def _create_session_sync(self, user_id: str, ttl_seconds: int) -> str:
        session_id = new_session_id()
        now = datetime.now(UTC)
        expires = now + timedelta(seconds=ttl_seconds)
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (session_id, user_id, now.isoformat(), expires.isoformat()),
            )
        return session_id

    async def get_session_user(self, session_id: str) -> User | None:
        return await asyncio.to_thread(self._get_session_user_sync, session_id)

    def _get_session_user_sync(self, session_id: str) -> User | None:
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT users.id, users.login, users.name, users.role, users.status,
                       users.color, users.created_at
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.id = ? AND sessions.expires_at > ?
                """,
                (session_id, now),
            ).fetchone()
            if row is None:
                conn.execute(
                    "DELETE FROM sessions WHERE id = ? AND expires_at <= ?",
                    (session_id, now),
                )
                return None
        return _row_to_user(row)

    async def delete_session(self, session_id: str) -> None:
        await asyncio.to_thread(self._delete_session_sync, session_id)

    def _delete_session_sync(self, session_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    async def delete_user_sessions(self, user_id: str) -> None:
        await asyncio.to_thread(self._delete_user_sessions_sync, user_id)

    def _delete_user_sessions_sync(self, user_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    async def prune_sessions(self) -> int:
        return await asyncio.to_thread(self._prune_sessions_sync)

    def _prune_sessions_sync(self) -> int:
        now = datetime.now(UTC).isoformat()
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        return cursor.rowcount

    # ------------------------------------------------------------- lifecycle

    async def ping(self) -> bool:
        return await asyncio.to_thread(self._ping_sync)

    def _ping_sync(self) -> bool:
        with self._connect() as conn:
            conn.execute("SELECT 1").fetchone()
        return True

    async def close(self) -> None:
        """Compatibility hook: connections are opened per call."""
        return None
