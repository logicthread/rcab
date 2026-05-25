#!/bin/bash
set -euo pipefail

TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
DUMP_FILE="/backups/rcab-${TIMESTAMP}.dump.gz"
ENCRYPTED_FILE="${DUMP_FILE}.age"

pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" --format=custom \
  | gzip > "$DUMP_FILE"

age -R /run/secrets/age.key -o "$ENCRYPTED_FILE" "$DUMP_FILE"
rm "$DUMP_FILE"

if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone copy "$ENCRYPTED_FILE" "${RCLONE_REMOTE}:${RCLONE_BUCKET}/daily/"
fi

find /backups -name "*.age" -mtime +7 -delete

echo "[backup] completed: ${ENCRYPTED_FILE}"
