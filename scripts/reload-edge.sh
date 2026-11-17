#!/usr/bin/env sh
# Reload the TLS edge after the shared Let's Encrypt certificate is renewed.
# The certificate itself is mounted read-only from the existing nginx-certbot
# volume; only this project's proxy is reloaded.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.vds.yml}
PROJECT=${COMPOSE_PROJECT_NAME:-whiteboard-prod}

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T edge \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null
