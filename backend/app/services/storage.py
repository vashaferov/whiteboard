"""SQLite snapshot storage for finished board state."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS room_snapshots (
    room_id    TEXT PRIMARY KEY,
    objects    TEXT NOT NULL,
    seq        INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
"""


@dataclass(frozen=True, slots=True)
class Snapshot:
    objects: list[dict[str, Any]]
    seq: int
    updated_at: str


class SnapshotStore:
    """Stores one JSON snapshot per room in SQLite.

    All blocking work is pushed to worker threads so the event loop stays free.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    async def load(self, room_id: str) -> Snapshot | None:
        return await asyncio.to_thread(self._load_sync, room_id)

    def _load_sync(self, room_id: str) -> Snapshot | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT objects, seq, updated_at FROM room_snapshots WHERE room_id = ?",
                (room_id,),
            ).fetchone()
        if row is None:
            return None
        try:
            objects = json.loads(row[0])
        except json.JSONDecodeError:
            logger.warning("Corrupted snapshot for room %s, ignoring", room_id)
            return None
        if not isinstance(objects, list):
            return None
        return Snapshot(objects=objects, seq=int(row[1]), updated_at=str(row[2]))

    async def save(self, room_id: str, objects: list[dict[str, Any]], seq: int) -> None:
        payload = json.dumps(objects, ensure_ascii=False, separators=(",", ":"))
        updated_at = datetime.now(UTC).isoformat()
        await asyncio.to_thread(self._save_sync, room_id, payload, seq, updated_at)

    def _save_sync(self, room_id: str, payload: str, seq: int, updated_at: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO room_snapshots (room_id, objects, seq, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(room_id) DO UPDATE SET
                    objects = excluded.objects,
                    seq = excluded.seq,
                    updated_at = excluded.updated_at
                """,
                (room_id, payload, seq, updated_at),
            )

    async def delete_older_than(self, days: int) -> int:
        return await asyncio.to_thread(self._delete_older_than_sync, days)

    def _delete_older_than_sync(self, days: int) -> int:
        cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM room_snapshots WHERE updated_at < ?", (cutoff,))
            return int(cursor.rowcount or 0)

    async def close(self) -> None:
        """Present for symmetry; connections are opened per operation."""

        return None

    async def ping(self) -> bool:
        """Cheap readiness probe for the SQLite file."""

        def _ping() -> bool:
            with self._connect() as conn:
                conn.execute("SELECT 1")
            return True

        try:
            return await asyncio.to_thread(_ping)
        except Exception:  # noqa: BLE001 - readiness must report, not raise
            logger.exception("SQLite readiness check failed")
            return False
