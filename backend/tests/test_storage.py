"""Unit-тесты SQLite-хранилища снимков."""

from __future__ import annotations

from pathlib import Path

from app.services.storage import SnapshotStore


async def test_snapshot_roundtrip(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "db" / "whiteboard.db")
    objects = [{"id": "o1", "type": "stroke"}, {"id": "o2", "type": "text", "content": "Привет"}]

    await store.save("room-1", objects, 42)
    snapshot = await store.load("room-1")

    assert snapshot is not None
    assert snapshot.objects == objects
    assert snapshot.seq == 42
    await store.close()


async def test_snapshot_update_replaces_row(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path / "whiteboard.db")
    await store.save("room-1", [{"id": "old"}], 1)
    await store.save("room-1", [{"id": "new"}], 2)

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
    await store.save("room-1", [{"id": "o1"}], 1)
    assert await store.delete_older_than(0) == 1
    assert await store.load("room-1") is None
    await store.close()
