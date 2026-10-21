#!/usr/bin/env bash
# Ships an export made by infra/local/export.sh to the deployed instance on the Pi and imports it there, carefully:
#   1. backs up the Pi (pg_dump + files volume) to /srv/quire/manual-backups and copies the backup to this laptop
#   2. dry-runs the import against the live database (everything loaded, then rolled back)
#   3. imports for real (one transaction: courses only; research projects untouched) and copies the files
#   4. compares row counts with the export's manifest and checks every stored file path exists
# Needs: ssh to the Pi (alias `researchpi`), the stack at /srv/quire, and both sides on the same commit (same
# schema). Re-running the same export fails on duplicate ids instead of doubling anything.
# Afterwards open each course's settings on the Pi and click "Index missing items" (embeddings are not exported).
set -euo pipefail
EXPORT="${1:?usage: migrate-to-pi.sh <export dir from export.sh>}"
EXPORT="${EXPORT%/}"
HOST="${PI_HOST:-researchpi}"
REMOTE_DIR="${PI_QUIRE_DIR:-/srv/quire}"
LOCAL_DIR="${QUIRE_LOCAL_DIR:-$HOME/Desktop/current-uni/quire-local}"
TS="$(date +%Y%m%d-%H%M%S)"
STAGE="/tmp/quire-import-$(basename "$EXPORT")"
COURSE="(select id from projects where kind = 'course')"

[ -f "$EXPORT/import.sql" ] && [ -f "$EXPORT/manifest.txt" ] || { echo "not an export: $EXPORT"; exit 1; }
remote() { ssh "$HOST" "cd '$REMOTE_DIR' && $1"; }
psql_remote() { ssh "$HOST" "cd '$REMOTE_DIR' && docker compose exec -T db psql -U quire -d quire -v ON_ERROR_STOP=1 -tA"; }

echo "1/4 Backing up the Pi"
B="$REMOTE_DIR/manual-backups/$TS-pre-course-import"
remote "mkdir -p '$B' \
  && docker compose exec -T db pg_dump -U quire -d quire -Fc > '$B/quire.dump' \
  && docker run --rm -v quire_files:/data:ro -v '$B':/out alpine tar czf /out/files.tgz -C /data ."
mkdir -p "$LOCAL_DIR/backups/pi-$TS-pre-course-import"
scp -q "$HOST:$B/*" "$LOCAL_DIR/backups/pi-$TS-pre-course-import/"
echo "   backup: $HOST:$B and $LOCAL_DIR/backups/pi-$TS-pre-course-import"

echo "2/4 Staging and dry run"
ssh "$HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"
scp -rq "$EXPORT"/. "$HOST:$STAGE/"
remote "docker compose exec -T db rm -rf /tmp/quire-import \
  && docker compose cp '$STAGE' db:/tmp/quire-import >/dev/null \
  && docker compose exec -T -w /tmp/quire-import db psql -U quire -d quire -v ON_ERROR_STOP=1 -v dry_run=1 -q -f import.sql"

echo "3/4 Importing rows and files"
remote "docker compose exec -T -w /tmp/quire-import db psql -U quire -d quire -v ON_ERROR_STOP=1 -q -f import.sql \
  && docker compose exec -T db rm -rf /tmp/quire-import \
  && if [ -n \"\$(ls -A '$STAGE/files' 2>/dev/null)\" ]; then \
       docker compose cp '$STAGE/files/.' app:/data/files/ >/dev/null \
       && docker compose exec -T -u root app chown -R quire:quire /data/files; \
     fi \
  && rm -rf '$STAGE'"

echo "4/4 Verifying"
fail=0
while read -r table want; do
  [ "$table" = files ] && continue
  case "$table" in
    projects) where="kind = 'course'" ;;
    document_pages) where="document_id in (select id from documents where project_id in $COURSE)" ;;
    chat_messages) where="thread_id in (select id from chat_threads where project_id in $COURSE)" ;;
    assignment_questions | assignment_files) where="assignment_id in (select id from assignments where project_id in $COURSE)" ;;
    test_questions | reread_items) where="test_id in (select id from tests where project_id in $COURSE)" ;;
    *) where="project_id in $COURSE" ;;
  esac
  got=$(echo "select count(*) from $table where $where;" | psql_remote)
  [ "$got" -ge "$want" ] || { echo "   $table: expected $want, found $got"; fail=1; }
done < "$EXPORT/manifest.txt"
missing=$(echo "select file_path from documents where file_path is not null and project_id in $COURSE
  union all select original_path from documents where original_path is not null and project_id in $COURSE;" \
  | psql_remote | ssh "$HOST" "cd '$REMOTE_DIR' && while read p; do [ -n \"\$p\" ] || continue; \
      docker compose exec -T app test -f \"/data/files/\$p\" </dev/null || echo \"\$p\"; done")
[ -z "$missing" ] || { echo "   missing files:"; echo "$missing"; fail=1; }
[ "$fail" = 0 ] && echo "   counts and files match" || { echo "Verification failed; the backup above restores the Pi."; exit 1; }
echo "Done. On the Pi, open each course's settings and click \"Index missing items\" for chat retrieval."
