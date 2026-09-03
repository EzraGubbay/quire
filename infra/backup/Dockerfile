FROM alpine:3.21
RUN apk add --no-cache postgresql17-client rclone bash tzdata dcron
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
CMD ["/bin/bash", "-c", "echo \"${BACKUP_CRON} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1\" | crontab - && crond -f -l 2"]
