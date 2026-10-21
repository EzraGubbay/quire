#!/usr/bin/env bash
# Ships an export made by infra/local/export.sh to the deployed instance on the Pi and imports it there:
# rows into its Postgres (courses only; research projects are untouched) and files into its `files` volume.
# Needs: ssh access to the Pi (alias `researchpi`), the stack at /srv/quire, and both sides on the same schema
# version (deploy the same commit first). Re-running with the same export fails on duplicate ids, by design.
set -euo pipefail
EXPORT="${1:?usage: migrate-to-pi.sh <export dir from export.sh>}"
HOST="${PI_HOST:-researchpi}"
REMOTE_DIR="${PI_QUIRE_DIR:-/srv/quire}"
STAGE="/tmp/quire-import-$(basename "$EXPORT")"

[ -f "$EXPORT/import.sql" ] || { echo "not an export: $EXPORT"; exit 1; }
echo "Copying $EXPORT to $HOST:$STAGE"
ssh "$HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"
scp -rq "$EXPORT"/. "$HOST:$STAGE/"

echo "Importing rows"
ssh "$HOST" "cd '$REMOTE_DIR' \
  && docker compose cp '$STAGE' db:/tmp/quire-import \
  && docker compose exec -T db sh -c 'cd /tmp/quire-import && psql -U quire -d quire -v ON_ERROR_STOP=1 -q -f import.sql' \
  && docker compose exec -T db rm -rf /tmp/quire-import"

echo "Copying files"
ssh "$HOST" "cd '$REMOTE_DIR' \
  && if [ -d '$STAGE/files' ] && [ -n \"\$(ls -A '$STAGE/files')\" ]; then \
       docker compose cp '$STAGE/files/.' app:/data/files/ \
       && docker compose exec -T -u root app chown -R quire:quire /data/files; \
     fi \
  && rm -rf '$STAGE'"

echo "Done. Open each course on the Pi and run Reindex (course settings) so chat retrieval covers it."
