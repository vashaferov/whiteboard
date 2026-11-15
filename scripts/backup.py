#!/usr/bin/env python3
"""Consistent backup of the SQLite snapshots and uploaded files.

Usage:
    python scripts/backup.py
    python scripts/backup.py --out-dir /backups --keep 14

The script uses the SQLite online backup API, so it is safe to run while the
application is writing. Uploads are packed into a zip archive. Each run creates
``backups/<UTC timestamp>/`` with ``whiteboard.db``, ``uploads.zip`` and
``manifest.json``; older backup directories are rotated.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Back up whiteboard data")
    parser.add_argument("--db", type=Path, default=PROJECT_ROOT / "data" / "whiteboard.db")
    parser.add_argument("--uploads", type=Path, default=PROJECT_ROOT / "uploads")
    parser.add_argument("--out-dir", type=Path, default=PROJECT_ROOT / "backups")
    parser.add_argument("--keep", type=int, default=7, help="Backups to keep (0 = all)")
    return parser.parse_args()


def backup_sqlite(source: Path, destination: Path) -> int:
    if not source.is_file():
        raise FileNotFoundError(f"database not found: {source}")
    source_conn = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        target_conn = sqlite3.connect(destination)
        try:
            source_conn.backup(target_conn)
        finally:
            target_conn.close()
    finally:
        source_conn.close()
    return destination.stat().st_size


def archive_uploads(source: Path, destination: Path) -> int:
    count = 0
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if source.is_dir():
            for path in sorted(source.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(source))
                    count += 1
    return count


def rotate(out_dir: Path, keep: int) -> None:
    if keep <= 0:
        return
    backups = sorted(
        (path for path in out_dir.iterdir() if path.is_dir() and (path / "manifest.json").is_file()),
        key=lambda path: path.name,
        reverse=True,
    )
    for stale in backups[keep:]:
        shutil.rmtree(stale, ignore_errors=True)


def main() -> int:
    args = parse_args()
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    target = args.out_dir / stamp
    target.mkdir(parents=True, exist_ok=False)

    try:
        db_bytes = backup_sqlite(args.db, target / "whiteboard.db")
        uploads = archive_uploads(args.uploads, target / "uploads.zip")
    except Exception as exc:  # noqa: BLE001 - CLI should print a clean error
        shutil.rmtree(target, ignore_errors=True)
        print(f"Backup failed: {exc}", file=sys.stderr)
        return 1

    manifest = {
        "created_at": datetime.now(UTC).isoformat(),
        "database": str(args.db),
        "db_bytes": db_bytes,
        "uploads": str(args.uploads),
        "upload_files": uploads,
    }
    (target / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    rotate(args.out_dir, args.keep)

    print(f"Backup written to {target}")
    print(f"  database: {db_bytes} bytes")
    print(f"  uploads:  {uploads} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
