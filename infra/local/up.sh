#!/usr/bin/env bash
# Starts (or updates) the local stack: creates the data folder on first run, then builds the image from the
# working tree and brings db, gotenberg and app up with restart: unless-stopped.
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR="${QUIRE_LOCAL_DIR:-$HOME/Desktop/current-uni/quire-local}"
mkdir -p "$DIR/files" "$DIR/pgdata" "$DIR/dumps"
[ -f "$DIR/local.env" ] || cp infra/local/local.env.example "$DIR/local.env"
[ -f "$DIR/README.md" ] || cp infra/local/README.md "$DIR/README.md"
docker compose -f infra/compose.local.yml up -d --build "$@"
echo
echo "Quire is at http://localhost:3000  (data in $DIR)"
ip=$(ipconfig getifaddr en0 2>/dev/null || true)
[ -n "$ip" ] && echo "On this Wi-Fi: http://$ip:3000"
