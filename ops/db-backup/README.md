# FBI Client File Studio PostgreSQL backup job

This directory is designed to run as a separate Railway service with this directory as its root.

- Image: built from the Dockerfile, which deliberately replaces the upstream PostgreSQL server entrypoint with the backup script.
- Job: creates a PostgreSQL 18 custom-format dump, validates its archive index with pg_restore, uploads it to the dedicated private backup bucket, and verifies the stored object has a non-zero size.
- Retention: removes only this job's backup objects older than 14 days.
- Secrets: use Railway variable references; never hard-code credentials.
- Schedule: daily at 03:15 UTC after a successful first run. First-run validation can temporarily use every 5 minutes, then switch to the daily schedule.
- Scope: this backs up PostgreSQL data/metadata. It does not make a second copy of the original media bucket. Test media retrieval/restore separately.

Example Railway environment references:
- DATABASE_URL = ${"{${Postgres.DATABASE_URL}}"}
- S3_ENDPOINT = ${"{${fbi-cfs-backups.ENDPOINT}}"}
- S3_BUCKET = ${"{${fbi-cfs-backups.BUCKET}}"}
- AWS_DEFAULT_REGION = ${"{${fbi-cfs-backups.REGION}}"}
- AWS_ACCESS_KEY_ID = ${"{${fbi-cfs-backups.ACCESS_KEY_ID}}"}
- AWS_SECRET_ACCESS_KEY = ${"{${fbi-cfs-backups.SECRET_ACCESS_KEY}}"}
- BACKUP_PREFIX = fbi-client-file-studio

The job requires outbound access to Railway's private Postgres hostname and the S3-compatible bucket endpoint.

A successful archive listing check is not a full database restore test. Restore a dump into a separate disposable PostgreSQL service in a controlled test, verify key tables/counts, and remove the temporary service only after validating recovery.
