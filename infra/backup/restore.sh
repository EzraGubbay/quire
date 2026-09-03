#!/bin/bash
# Restore the newest dump (or the one given as $1) into the running db. Run inside the backup container:
#   docker compose exec backup restore.sh [dumpfile]
set -euo pipefail
dump=${1:-$(ls -t /backups/db/quire-*.dump | head -1)}
echo "[restore] restoring $dump into $PGDATABASE"
pg_restore --clean --if-exists --no-owner --dbname="$PGDATABASE" "$dump"
echo "[restore] done"
