FROM alpine:3.21
RUN apk add --no-cache postgresql17-client rclone bash tzdata
COPY backup.sh restore.sh entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh
CMD ["/usr/local/bin/entrypoint.sh"]
