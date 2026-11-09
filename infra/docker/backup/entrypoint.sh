#!/bin/bash
# busybox crond starts jobs with a minimal environment, so PGHOST/PGPASSWORD/
# RCLONE_CONFIG_*/AGE_* from the compose env_file would be invisible to backup.sh.
# Snapshot them into a root-only file that the cron line sources.
set -euo pipefail
umask 077
: > /etc/backup-env.sh
for v in $(compgen -e | grep -E '^(PG|RCLONE|BACKUP|AGE|TZ)'); do
  printf 'export %s=%q\n' "$v" "${!v}" >> /etc/backup-env.sh
done
if [ "${BACKUP_RUN_ON_START:-0}" = "1" ]; then
  ( . /etc/backup-env.sh; /usr/local/bin/backup.sh ) || echo "[backup] initial run failed (exit $?)" >&2
fi
exec "$@"
