#!/bin/sh
# Schedule backup.sh with busybox crond (part of Alpine's base image). Cron output goes to the container log.
set -eu
: "${BACKUP_CRON:=15 3 * * *}"
echo "${BACKUP_CRON} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "[backup] scheduled '${BACKUP_CRON}' (UTC)"
exec crond -f -l 6 -L /dev/stdout
