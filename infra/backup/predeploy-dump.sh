#!/bin/bash
# Pre-deploy safety dump. deploy.yml pipes this file into the running backup container:
#   docker compose exec -T backup bash -s -- <from-sha> <to-sha> < infra/backup/predeploy-dump.sh
# It writes /backups/predeploy/quire-predeploy-<utc>-<from>-to-<to>.dump and keeps the newest
# PREDEPLOY_KEEP (default 5). Local only: the nightly backup.sh covers off-site copies. It exits non-zero on
# any failure and leaves no partial file, so the deploy aborts before anything changes.
# Credentials come from the container's PG* environment. Never echo them, and never use `set -x`.
# shellcheck disable=SC2012 # the file names are ours (ASCII timestamps), ls is safe here
set -euo pipefail
from=${1:?from sha}
to=${2:?to sha}
keep=${PREDEPLOY_KEEP:-5}
min_free_kib=${PREDEPLOY_MIN_FREE_KIB:-1048576}
dir=/backups/predeploy
mkdir -p "$dir"
rm -f "$dir"/*.partial
# Postgres shares this disk: refuse to dump unless there is room for 3x the newest dump (and at least 1 GiB).
newest=$(ls -1t /backups/db/*.dump "$dir"/*.dump 2>/dev/null | head -1 || true)
need=$min_free_kib
if [[ -n "$newest" ]]; then
  s=$(du -k "$newest" | cut -f1)
  if ((s * 3 > need)); then need=$((s * 3)); fi
fi
avail=$(df -Pk "$dir" | awk 'NR==2 {print $4}')
if ((avail < need)); then
  echo "[predeploy] only ${avail} KiB free, need ${need} KiB; not dumping" >&2
  exit 1
fi
ts=$(date -u +%Y%m%dT%H%M%SZ)
final="$dir/quire-predeploy-${ts}-${from}-to-${to}.dump"
part="$final.partial"
trap 'rm -f "$part"' EXIT
start=$(date +%s)
pg_dump --no-password --format=custom --compress=6 --file="$part"
pg_restore --list "$part" >/dev/null # the archive's table of contents reads back
[[ -s "$part" ]]
mv "$part" "$final"
echo "[predeploy] wrote $(basename "$final") ($(du -h "$final" | cut -f1)) in $(($(date +%s) - start))s"
mapfile -t dumps < <(ls -1 "$dir"/quire-predeploy-*.dump | sort) # names sort by UTC timestamp
for ((i = 0; i < ${#dumps[@]} - keep; i++)); do
  rm -f -- "${dumps[i]}"
  echo "[predeploy] pruned $(basename "${dumps[i]}")"
done
echo "[predeploy] keeping $(ls -1 "$dir"/quire-predeploy-*.dump | wc -l) of at most ${keep}; $(df -h "$dir" | awk 'NR==2 {print $4}') free"
