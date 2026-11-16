"""Unit-тесты SQLite-хранилища снимков."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.services.storage import SnapshotStore
from app.services.workspaces import default_workspace


async def test_snapshot_roundtrip(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "db" / "whiteboard.db")
    objects = [{"id": "o1", "type": "stroke"}, {"id": "o2", "type": "text", "content": "Привет"}]

    await store.save("room-1", objects, 42, [])
    snapshot = await store.load("room-1")

    assert snapshot is not None
    assert snapshot.objects == objects
    assert snapshot.workspaces == []
    assert snapshot.seq == 42
    await store.close()


async def test_snapshot_update_replaces_row(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "whiteboard.db")
    await store.save("room-1", [{"id": "old"}], 1, [])
    await store.save("room-1", [{"id": "new"}], 2, [])

    snapshot = await store.load("room-1")
    assert snapshot is not None
    assert snapshot.objects == [{"id": "new"}]
    assert snapshot.seq == 2
    await store.close()


async def test_missing_snapshot_returns_none(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "whiteboard.db")
    assert await store.load("unknown") is None
    await store.close()


async def test_cleanup_removes_expired_snapshots(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "whiteboard.db")
    await store.save("room-1", [{"id": "o1"}], 1, [])
    assert await store.delete_older_than(0) == 1
    assert await store.load("room-1") is None
    await store.close()


async def test_snapshot_roundtrip_preserves_workspaces(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "whiteboard.db")
    workspaces = [default_workspace(), {"id": "ws_extra", "name": "Черновик", "position": 1}]
    await store.save("room-1", [{"id": "o1", "workspaceId": "ws_extra"}], 7, workspaces)
    snapshot = await store.load("room-1")
    assert snapshot is not None
    assert snapshot.workspaces == workspaces
    assert snapshot.objects[0]["workspaceId"] == "ws_extra"


async def test_legacy_database_is_migrated(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE room_snapshots (room_id TEXT PRIMARY KEY, objects TEXT NOT NULL, "
        "seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO room_snapshots VALUES ('old', '[{\"id\": \"o1\"}]', 3, '2026-01-01T00:00:00+00:00')"
    )
    conn.commit()
    conn.close()

    store = SnapshotStore(path)
    snapshot = await store.load("old")
    assert snapshot is not None
    assert snapshot.objects == [{"id": "o1"}]
    assert snapshot.workspaces == []
    assert snapshot.seq == 3


async def test_delete_snapshot(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "whiteboard.db")
    await store.save("room-1", [{"id": "o1"}], 1, [])

    await store.delete("room-1")
    assert await store.load("room-1") is None
    await store.delete("room-1")  # идемпотентно
