#!/bin/bash
# Nightly: pg_dump to /backups, prune local copies older than 14 days, sync dumps + files to B2.
set -euo pipefail
ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /backups/db
pg_dump --format=custom --compress=6 --file="/backups/db/quire-${ts}.dump"
find /backups/db -name 'quire-*.dump' -mtime +14 -delete
echo "[backup] dumped quire-${ts}.dump"
if [[ -n "${B2_ACCOUNT_ID:-}" && -n "${B2_APPLICATION_KEY:-}" ]]; then
  export RCLONE_CONFIG_B2_TYPE=b2 RCLONE_CONFIG_B2_ACCOUNT="$B2_ACCOUNT_ID" RCLONE_CONFIG_B2_KEY="$B2_APPLICATION_KEY"
  rclone sync /backups/db "b2:${B2_BUCKET}/db" --fast-list --transfers 4
  rclone sync /data/files "b2:${B2_BUCKET}/files" --fast-list --transfers 4
  echo "[backup] synced to b2:${B2_BUCKET}"
else
  echo "[backup] B2 credentials not set; local dump only"
fi
