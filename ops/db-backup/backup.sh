#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL reference is missing}"
: "${S3_ENDPOINT:?S3_ENDPOINT reference is missing}"
: "${S3_BUCKET:?S3_BUCKET reference is missing}"
: "${AWS_DEFAULT_REGION:?Bucket region reference is missing}"
: "${AWS_ACCESS_KEY_ID:?Bucket access key reference is missing}"
: "${AWS_SECRET_ACCESS_KEY:?Bucket secret reference is missing}"
: "${BACKUP_PREFIX:?Backup prefix is missing}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="postgres/${BACKUP_PREFIX}/${STAMP}.dump"
FILE="/tmp/fbi-postgres-${STAMP}.dump"

DATABASE_NAME="$(psql --dbname="$DATABASE_URL" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command='SELECT current_database()')"
[ -n "$DATABASE_NAME" ] || { echo "Unable to identify the source database." >&2; exit 1; }
echo "Starting PostgreSQL backup archive for database: $DATABASE_NAME"
pg_dump --dbname="$DATABASE_URL" --format=custom --compress=6 --no-owner --no-acl --file="$FILE"
test -s "$FILE"
pg_restore --list "$FILE" >/dev/null

aws s3 cp "$FILE" "s3://${S3_BUCKET}/${KEY}" \
  --endpoint-url "$S3_ENDPOINT" --region "$AWS_DEFAULT_REGION" --only-show-errors
SIZE="$(aws s3api head-object --bucket "$S3_BUCKET" --key "$KEY" \
  --endpoint-url "$S3_ENDPOINT" --region "$AWS_DEFAULT_REGION" \
  --query ContentLength --output text)"
case "$SIZE" in
  ''|*[!0-9]*) echo "Backup object size check returned an invalid value." >&2; exit 1 ;;
esac
if [ "$SIZE" -le 0 ]; then
  echo "Backup object is empty." >&2
  exit 1
fi

# Retain 14 days of backups; cleanup is scoped to this backup prefix only.
CUTOFF="$(date -u -d '14 days ago' +%s)"
LISTING="$(aws s3 ls "s3://${S3_BUCKET}/postgres/${BACKUP_PREFIX}/" --recursive \
  --endpoint-url "$S3_ENDPOINT" --region "$AWS_DEFAULT_REGION")"
printf '%s\n' "$LISTING" | while read -r OBJECT_DATE OBJECT_TIME OBJECT_SIZE OBJECT_KEY; do
  [ -n "$OBJECT_KEY" ] || continue
  OBJECT_EPOCH="$(date -u -d "$OBJECT_DATE $OBJECT_TIME" +%s 2>/dev/null || printf '0')"
  if [ "$OBJECT_EPOCH" -gt 0 ] && [ "$OBJECT_EPOCH" -lt "$CUTOFF" ]; then
    aws s3 rm "s3://${S3_BUCKET}/${OBJECT_KEY}" \
      --endpoint-url "$S3_ENDPOINT" --region "$AWS_DEFAULT_REGION" --only-show-errors
  fi
done

echo "PostgreSQL backup verified: s3://${S3_BUCKET}/${KEY} (${SIZE} bytes)."
