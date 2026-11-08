#!/bin/bash
# rcab Postgres backup (RCAB-E8.S3).
#
#   pg_dump -Fc  ->  [age encrypt]  ->  verify  ->  sha256 + manifest  ->  /backups
#   -> optional rclone offsite (env-configured)  ->  retention prune
#
# Output files for one run (all-or-nothing; the manifest is written LAST, so a
# backup without a manifest is incomplete and must not be restored):
#   rcab-<UTC ts>.dump[.age]            the dump (custom format; encrypted when age is configured)
#   rcab-<UTC ts>.dump[.age].sha256     `sha256sum` format
#   rcab-<UTC ts>.manifest.json         what/when/size/sha256/server+migration facts
#
# Exit codes: 0 ok | 1 backup failed (nothing kept) | 2 local backup OK but offsite
# failed (local copy kept, .last_offsite_failure written) | 3 another run in progress.
#
# Environment (all via compose env_file; see env.example/backup.env.example):
#   PGHOST PGPORT PGUSER PGPASSWORD PGDB        connection (PGPASSWORD must match POSTGRES_PASSWORD)
#   BACKUP_DIR=/backups                         local volume (the default and only required target)
#   AGE_RECIPIENTS_FILE=/run/secrets/age.key    PUBLIC recipient(s) for `age -R`. The matching
#                                               private identity is NEVER stored here.
#   BACKUP_ALLOW_PLAINTEXT=0                    1 = permit an unencrypted dump when no recipients
#                                               file exists (dev / drills only)
#   BACKUP_KEEP_DAILY=30  BACKUP_KEEP_MONTHLY=12   local retention (see prune_local)
#   BACKUP_MIN_FREE_MB=1024                     refuse to start below this much free space
#   RCLONE_REMOTE / RCLONE_BUCKET / RCLONE_PREFIX / RCLONE_PRUNE / RCLONE_KEEP_DAILY_DAYS
#       Offsite is OFF unless RCLONE_REMOTE is set. The remote itself is defined by
#       RCLONE_CONFIG_<REMOTE>_* environment variables (no config file needed).
set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups}"
PGPORT="${PGPORT:-5432}"
PGDB="${PGDB:-${PGDATABASE:-rcab}}"
: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
AGE_RECIPIENTS_FILE="${AGE_RECIPIENTS_FILE:-/run/secrets/age.key}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-30}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-12}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-1024}"
export PGHOST PGPORT PGUSER

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"

# One run at a time (a slow dump must not overlap the next cron tick).
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { log "another backup is running; exiting" >&2; exit 3; }

TS="$(date -u +%Y%m%d-%H%M%S)"
TMP="$BACKUP_DIR/.tmp-$TS"
# Remove only our own temp dir (never an empty/unset path).
cleanup() { [ -n "${TMP:-}" ] && rm -rf -- "${TMP:?}"; }
trap cleanup EXIT
# A previous run killed hard (OOM, docker stop) can leave a partial temp dir behind.
find "$BACKUP_DIR" -maxdepth 1 -name '.tmp-*' -mmin +120 -exec rm -rf -- {} + 2>/dev/null || true
mkdir -p "$TMP"

# ── preflight ────────────────────────────────────────────────────────────────
free_mb="$(df -Pm "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
[ "${free_mb:-0}" -ge "$MIN_FREE_MB" ] || die "only ${free_mb}MB free in $BACKUP_DIR (< BACKUP_MIN_FREE_MB=$MIN_FREE_MB)"

pg_isready -q -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" || die "postgres $PGHOST:$PGPORT not accepting connections"
# Authentication check up front: a clear message beats a half-written pipeline.
psql -X -At -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -c 'SELECT 1' >/dev/null \
  || die "cannot authenticate to $PGHOST:$PGPORT/$PGDB as $PGUSER (is PGPASSWORD set and equal to POSTGRES_PASSWORD?)"

ENCRYPT=0
if [ -f "$AGE_RECIPIENTS_FILE" ] && [ -s "$AGE_RECIPIENTS_FILE" ]; then
  if grep -q 'AGE-SECRET-KEY-' "$AGE_RECIPIENTS_FILE"; then
    die "$AGE_RECIPIENTS_FILE contains a PRIVATE age identity. Mount only the public recipient(s) (age1...; derive with: age-keygen -y <identity>) and keep the identity off this host."
  fi
  grep -Eq '^(age1|ssh-)' "$AGE_RECIPIENTS_FILE" || die "$AGE_RECIPIENTS_FILE has no age1.../ssh-... recipient line"
  ENCRYPT=1
elif [ "${BACKUP_ALLOW_PLAINTEXT:-0}" = "1" ]; then
  log "WARNING: no recipients file at $AGE_RECIPIENTS_FILE; writing an UNENCRYPTED dump (BACKUP_ALLOW_PLAINTEXT=1)"
else
  die "no age recipients file at $AGE_RECIPIENTS_FILE and BACKUP_ALLOW_PLAINTEXT is not 1; refusing to write a plaintext dump"
fi

BASE="rcab-${TS}.dump"
OUT="$BASE"; [ "$ENCRYPT" = 1 ] && OUT="${BASE}.age"

# ── dump (no plaintext file ever touches disk when encrypting) ───────────────
log "dumping $PGDB@$PGHOST (encrypt=$ENCRYPT)"
if [ "$ENCRYPT" = 1 ]; then
  pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" --format=custom \
    | age -R "$AGE_RECIPIENTS_FILE" -o "$TMP/$OUT"
else
  pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" --format=custom -f "$TMP/$OUT"
fi
[ -s "$TMP/$OUT" ] || die "dump is empty"

# ── verify what we can without the decryption identity ──────────────────────
if [ "$ENCRYPT" = 1 ]; then
  head -c 22 "$TMP/$OUT" | grep -q '^age-encryption.org/v1' || die "output is not an age v1 file"
else
  entries="$(pg_restore --list "$TMP/$OUT" | grep -vc '^;' || true)"
  [ "${entries:-0}" -gt 0 ] || die "pg_restore --list found no objects in the dump"
fi

SIZE="$(wc -c < "$TMP/$OUT" | tr -d ' ')"
SHA="$(cd "$TMP" && sha256sum "$OUT" | tee "$OUT.sha256" | awk '{print $1}')"

# ── manifest ────────────────────────────────────────────────────────────────
q() { psql -X -At -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -c "$1" 2>/dev/null || true; }
SERVER_VERSION="$(q 'SHOW server_version')"
MIG_COUNT="$(q 'SELECT count(*) FROM _rcab_migrations')"
MIG_LAST="$(q 'SELECT name FROM _rcab_migrations ORDER BY name DESC LIMIT 1')"
PGDUMP_VERSION="$(pg_dump --version | awk '{print $NF}')"
MANIFEST="rcab-${TS}.manifest.json"
cat > "$TMP/$MANIFEST" <<JSON
{
  "format": 1,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "$PGDB",
  "file": "$OUT",
  "size_bytes": $SIZE,
  "sha256": "$SHA",
  "encrypted": $([ "$ENCRYPT" = 1 ] && echo true || echo false),
  "dump_format": "pg_dump custom (-Fc)",
  "pg_dump_version": "$PGDUMP_VERSION",
  "server_version": "$SERVER_VERSION",
  "migrations_applied": ${MIG_COUNT:-0},
  "last_migration": "${MIG_LAST}"
}
JSON

# ── publish atomically: dump, checksum, then manifest ───────────────────────
mv "$TMP/$OUT" "$BACKUP_DIR/$OUT"
mv "$TMP/$OUT.sha256" "$BACKUP_DIR/$OUT.sha256"
mv "$TMP/$MANIFEST" "$BACKUP_DIR/$MANIFEST"
date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/.last_success"
log "local backup complete: $BACKUP_DIR/$OUT ($SIZE bytes, sha256=$SHA)"

# ── offsite (optional) ──────────────────────────────────────────────────────
rc=0
offsite() {
  local remote="${RCLONE_REMOTE}:${RCLONE_BUCKET:?RCLONE_BUCKET is required with RCLONE_REMOTE}/${RCLONE_PREFIX:-rcab}"
  local tier f
  local files=("$OUT" "$OUT.sha256" "$MANIFEST")
  local tiers=(daily)
  # Monthly copy = the run that lands on the 1st (UTC). Force with BACKUP_FORCE_MONTHLY=1.
  if [ "$(date -u +%d)" = "01" ] || [ "${BACKUP_FORCE_MONTHLY:-0}" = "1" ]; then tiers+=(monthly); fi
  for tier in "${tiers[@]}"; do
    local -a inc=()
    for f in "${files[@]}"; do
      rclone copyto "$BACKUP_DIR/$f" "$remote/$tier/$f" || return 1
      inc+=(--include "$f")
    done
    # Compare size and (where the remote supports it) hash of what it now holds.
    rclone check "$BACKUP_DIR" "$remote/$tier" --one-way "${inc[@]}" || return 1
    log "offsite $tier copy verified: $remote/$tier/$OUT"
  done
  if [ "${RCLONE_PRUNE:-1}" = "1" ]; then
    rclone delete "$remote/daily"   --min-age "${RCLONE_KEEP_DAILY_DAYS:-30}d" || return 1
    rclone delete "$remote/monthly" --min-age "$((KEEP_MONTHLY * 31 + 7))d"    || return 1
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/.last_offsite_success"
  rm -f -- "${BACKUP_DIR:?}/.last_offsite_failure"
}
if [ -n "${RCLONE_REMOTE:-}" ]; then
  if ! offsite; then
    log "ERROR: offsite upload/verification failed; local backup retained" >&2
    date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/.last_offsite_failure"
    rc=2
  fi
fi

# ── local retention ─────────────────────────────────────────────────────────
# Keep (a) the newest KEEP_DAILY backups, and (b) the OLDEST backup of each of
# the newest KEEP_MONTHLY calendar months (UTC). Never deletes the newest backup.
prune_local() {
  local -a all=()
  local f m n=0 i base
  while IFS= read -r f; do all+=("$f"); done < <(
    ls -1 "$BACKUP_DIR" | grep -E '^rcab-[0-9]{8}-[0-9]{6}\.dump(\.age)?$' | sort)   # oldest first
  [ "${#all[@]}" -gt 0 ] || return 0
  declare -A month_first=() kept=()
  for f in "${all[@]}"; do
    m="${f:5:6}"                                   # YYYYMM
    [ -n "${month_first[$m]:-}" ] || month_first[$m]="$f"
  done
  local months; months="$(printf '%s\n' "${!month_first[@]}" | sort -r | head -n "$KEEP_MONTHLY")"
  for m in $months; do kept["${month_first[$m]}"]=1; done
  for ((i = ${#all[@]} - 1; i >= 0 && n < KEEP_DAILY; i--, n++)); do kept["${all[$i]}"]=1; done
  for f in "${all[@]}"; do
    [ -n "${kept[$f]:-}" ] && continue
    base="${f%.age}"; base="${base%.dump}"
    log "retention: removing $f"
    rm -f -- "${BACKUP_DIR:?}/${f:?}" "${BACKUP_DIR:?}/${f:?}.sha256" "${BACKUP_DIR:?}/${base:?}.manifest.json"
  done
}
prune_local

log "done (exit $rc)"
exit "$rc"
