#!/usr/bin/env sh
# Deploy the isolated whiteboard stack on a VDS that runs other containers.
#
# Runs on the server, normally over SSH from GitHub Actions:
#   WB_TAG=<git-sha> ./scripts/deploy.sh
#
# Environment:
#   WB_TAG            image tag to run (default: latest)
#   WB_PORT           loopback port from .env (default: 8010)
#   COMPOSE_FILE      compose file (default: docker-compose.vds.yml)
#   COMPOSE_PROJECT_NAME  compose project (default: whiteboard-prod)
#   DEPLOY_BRANCH     git branch to update from (default: main)
#   GHCR_USER/GHCR_TOKEN  optional registry login for a private package
#   PUBLIC_HEALTH_URL optional public URL checked after the container is healthy
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.vds.yml}
PROJECT=${COMPOSE_PROJECT_NAME:-whiteboard-prod}
BRANCH=${DEPLOY_BRANCH:-main}
TAG=${WB_TAG:-latest}

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

if [ ! -f "$COMPOSE_FILE" ]; then
  log "compose file not found: $COMPOSE_FILE"
  exit 1
fi

if [ -f .env ]; then
  WB_PORT=${WB_PORT:-$(sed -n 's/^WB_PORT=//p' .env | tail -n 1)}
fi
WB_PORT=${WB_PORT:-8010}

# Pull the manifests first and restart this script so an updated deploy.sh is
# used. The flag prevents a second update loop.
if [ "${WB_DEPLOY_REEXEC:-0}" != "1" ]; then
  log "updating $BRANCH from origin"
  git fetch --prune origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
  export WB_DEPLOY_REEXEC=1
  exec sh "$0" "$@"
fi

if [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "$GHCR_TOKEN" |
    docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin >/dev/null
fi

compose() {
  WB_TAG="$TAG" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

log "pulling whiteboard:$TAG"
compose pull whiteboard

log "starting $PROJECT"
compose up -d --no-build --remove-orphans

wait_healthy() {
  service=$1
  container_id=$(compose ps -q "$service")
  attempt=0
  status=""
  while [ "$attempt" -lt 30 ]; do
    if [ -n "$container_id" ]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
        "$container_id" 2>/dev/null || true)
    fi
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  log "health check failed: $PROJECT/$service"
  compose ps || true
  compose logs --tail=80 "$service" || true
  return 1
}

wait_healthy whiteboard
wait_healthy edge

# Pick up a renewed certificate without recreating the container.
compose exec -T edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
  </dev/null >/dev/null 2>&1 || true

if [ -n "${PUBLIC_HEALTH_URL:-}" ]; then
  log "checking $PUBLIC_HEALTH_URL"
  if ! curl -fsS --max-time 10 "$PUBLIC_HEALTH_URL" >/dev/null; then
    log "public health check failed"
    exit 1
  fi
fi

# Remove only dangling images that belong to this project. Images built by the
# workflow carry the same label; other projects are untouched.
docker image prune -f --filter "label=com.docker.compose.project=$PROJECT" >/dev/null 2>&1 || true

log "deployed $BRANCH@$TAG on port $WB_PORT"
