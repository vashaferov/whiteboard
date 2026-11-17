#!/usr/bin/env sh
# Backup the production compose volumes (SQLite + local uploads) from the host.
#
# Usage:
#   ./scripts/backup-docker.sh
#   KEEP=30 ./scripts/backup-docker.sh
#
# Volume names follow the compose project name (directory name by default).
# Override them with DATA_VOLUME / UPLOADS_VOLUME if needed.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROJECT_NAME=${COMPOSE_PROJECT_NAME:-$(basename "$PROJECT_DIR")}
DATA_VOLUME=${DATA_VOLUME:-${PROJECT_NAME}_whiteboard-data}
UPLOADS_VOLUME=${UPLOADS_VOLUME:-${PROJECT_NAME}_whiteboard-uploads}
KEEP=${KEEP:-14}

mkdir -p "$PROJECT_DIR/backups"

docker run --rm \
  -v "$DATA_VOLUME:/data:ro" \
  -v "$UPLOADS_VOLUME:/uploads:ro" \
  -v "$PROJECT_DIR/backups:/backups" \
  -v "$PROJECT_DIR/scripts:/scripts:ro" \
  python:3.13-slim python /scripts/backup.py \
  --db /data/whiteboard.db --uploads /uploads --out-dir /backups --keep "$KEEP"
