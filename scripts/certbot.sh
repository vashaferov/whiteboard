#!/usr/bin/env sh
# Issue or renew the board certificate through the shared ACME webroot.
#
# Port 80 belongs to the existing nginx, so HTTP-01 challenges are served from
# its webroot. The certificate itself is stored in our own directory and never
# modifies the existing nginx-certbot state.
#
# Usage:
#   ./scripts/certbot.sh init    # first issuance
#   ./scripts/certbot.sh renew   # cron / manual renewal
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.vds.yml}
PROJECT=${COMPOSE_PROJECT_NAME:-whiteboard-prod}
IMAGE=${CERTBOT_IMAGE:-certbot/certbot:latest}

read_env() {
  sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1
}

DOMAIN=${DOMAIN:-$(read_env DOMAIN)}
EMAIL=${CERTBOT_EMAIL:-$(read_env CERTBOT_EMAIL)}
WEBROOT=${CERTBOT_WEBROOT:-$(read_env CERTBOT_WEBROOT)}
CERT_DIR=${CERT_DIR:-$(read_env TLS_CERTS_DIR)}
LOG_DIR=${CERTBOT_LOG_DIR:-${HOME}/whiteboard-certs-log}

: "${DOMAIN:?DOMAIN is not set}"
: "${WEBROOT:?CERTBOT_WEBROOT is not set}"
: "${CERT_DIR:?TLS_CERTS_DIR is not set}"

mkdir -p "$CERT_DIR" "$LOG_DIR"

run_certbot() {
  docker run --rm \
    -v "$CERT_DIR:/etc/letsencrypt" \
    -v "$LOG_DIR:/var/log/letsencrypt" \
    -v "$WEBROOT:/var/www/certbot" \
    "$IMAGE" "$@"
}

action=${1:-renew}
case "$action" in
  init)
    : "${EMAIL:?CERTBOT_EMAIL is not set}"
    run_certbot certonly --webroot -w /var/www/certbot \
      -d "$DOMAIN" --cert-name "$DOMAIN" --email "$EMAIL" \
      --agree-tos --non-interactive --key-type ecdsa
    ;;
  renew)
    run_certbot renew --webroot -w /var/www/certbot --non-interactive
    ;;
  *)
    echo "usage: $0 [init|renew]" >&2
    exit 2
    ;;
esac

# Pick up a renewed certificate in the running edge.
if [ -n "$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q edge 2>/dev/null)" ]; then
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" exec -T edge \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
fi
