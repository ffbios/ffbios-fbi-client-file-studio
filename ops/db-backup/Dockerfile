FROM postgres:18-alpine
RUN apk add --no-cache aws-cli
COPY backup.sh /usr/local/bin/fbi-postgres-backup.sh
RUN chmod 0755 /usr/local/bin/fbi-postgres-backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/fbi-postgres-backup.sh"]
