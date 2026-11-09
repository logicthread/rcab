#!/usr/bin/env bash
# End-to-end rehearsal of the backup container + restore drill on FIXTURE data (RCAB-E8.S3).
# Self-contained and secret-free: everything runs in throwaway containers on a private
# docker network; nothing touches the dev/prod stack, real backups, or real keys.
#
# What it proves (each line prints PASS/FAIL, exit 1 on any FAIL):
#   1  migrations + fixture load into a source Postgres
#   2  backup.sh (the real image) writes dump + .sha256 + manifest, encrypted with a freshly
#      generated age recipient, and its auth/format guards reject bad config
#   3  retention keeps newest-N + oldest-of-each-month and removes the rest (with sidecars)
#   4  the optional rclone offsite path (env-only remote, local backend) uploads and verifies
#      a daily and a monthly copy
#   5  restore-drill.sh restores the LOCAL copy and the OFFSITE copy with the age identity
#   6  a corrupted backup is rejected by the drill
#
# Usage: scripts/recovery/backup-rehearsal.sh [--keep]
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2
KEEP=0; [[ "${1:-}" == "--keep" ]] && KEEP=1

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

RUN="$(date -u +%H%M%S)-$$"
NET="rcab-rehearsal-$RUN"
SRC="rcab-rehearsal-src-$RUN"
WORK="$(mktemp -d)"
TOOLS_IMAGE="${BACKUP_TOOLS_IMAGE:-rcab-backup-tools:local}"
export BACKUP_TOOLS_IMAGE="$TOOLS_IMAGE"
PG_IMAGE="$(awk '/^FROM /{print $2; exit}' infra/docker/postgres/Dockerfile)"
FAILS=0; RESULTS=()

ok()   { RESULTS+=("[PASS] $*"); }
bad()  { RESULTS+=("[FAIL] $*"); FAILS=$((FAILS + 1)); }
step() { echo "[rehearsal] $*" >&2; }
expect() { # description, expected_rc, actual_rc
  if [[ "$3" == "$2" ]]; then ok "$1 (exit $3)"; else bad "$1 (expected exit $2, got $3)"; fi
}

cleanup() {
  if [[ "$KEEP" == 1 ]]; then step "kept: network $NET, container $SRC, workdir $WORK"; return; fi
  docker rm -f "$SRC" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  # WORK is the mktemp -d directory created above; only remove it from a system temp location.
  case "$WORK" in /tmp/*|/var/folders/*|/private/var/folders/*|/private/tmp/*) rm -rf -- "${WORK:?}" ;; esac
}
trap cleanup EXIT

backup_run() { # extra docker args..., last arg is not special; env via -e flags passed by caller
  docker run --rm --network "$NET" \
    -e PGHOST="$SRC" -e PGUSER=postgres -e PGPASSWORD=rehearsal -e PGDB=rcab \
    -e BACKUP_MIN_FREE_MB=1 \
    -v "$WORK/backups:/backups" "$@"
}

step "building backup image ($TOOLS_IMAGE)"
docker build -q -t "$TOOLS_IMAGE" infra/docker/backup >/dev/null || { echo "image build failed" >&2; exit 2; }

step "generating a throwaway age key pair"
docker run --rm --entrypoint age-keygen "$TOOLS_IMAGE" 2> /dev/null > "$WORK/identity"
docker run --rm -i --entrypoint age-keygen "$TOOLS_IMAGE" -y < "$WORK/identity" > "$WORK/recipient.pub"
chmod 600 "$WORK/identity"
grep -q '^age1' "$WORK/recipient.pub" && ok "age key pair generated (identity kept outside the backup mounts)" || bad "age key pair generation"
mkdir -p "$WORK/backups" "$WORK/offsite"

step "starting source postgres $SRC"
docker network create "$NET" >/dev/null
docker run -d --name "$SRC" --network "$NET" --tmpfs /var/lib/postgresql/data:rw,size=1g \
  -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=rcab "$PG_IMAGE" -c fsync=off >/dev/null || { echo "postgres start failed" >&2; exit 2; }
for _ in $(seq 1 180); do
  docker logs "$SRC" 2>&1 | grep -q 'PostgreSQL init process complete' && docker exec "$SRC" pg_isready -q -U postgres && break
  sleep 1
done
psql_src() { docker exec -i "$SRC" psql -X -q -U postgres -d rcab -v ON_ERROR_STOP=1 "$@"; }

step "applying migrations (as src/migrate.ts does) + loading fixture"
psql_src -c "CREATE TABLE IF NOT EXISTS _rcab_migrations (id serial PRIMARY KEY, name text NOT NULL UNIQUE, ran_at timestamptz NOT NULL DEFAULT now())" >/dev/null
mig_ok=1
for f in $(cd apps/api/migrations && ls -1 *.sql | sort); do
  if psql_src --single-transaction -f - < "apps/api/migrations/$f" >/dev/null 2>"$WORK/mig.err"; then
    psql_src -c "INSERT INTO _rcab_migrations (name) VALUES ('$f')" >/dev/null
  else mig_ok=0; echo "migration $f failed: $(head -c 300 "$WORK/mig.err")" >&2; break; fi
done
psql_src -f - < scripts/recovery/fixture.sql >/dev/null 2>"$WORK/fx.err" && fx_ok=1 || { fx_ok=0; head -c 400 "$WORK/fx.err" >&2; }
[[ "$mig_ok" == 1 && "$fx_ok" == 1 ]] && ok "source database migrated and loaded with fixture rows" || bad "source database setup"

# ── guards: bad configuration must fail loudly, not write a backup ───────────
step "backup guard checks"
backup_run -e PGPASSWORD=wrong -e BACKUP_ALLOW_PLAINTEXT=1 "$TOOLS_IMAGE" /usr/local/bin/backup.sh >"$WORK/g1.log" 2>&1; rc=$?
expect "wrong PGPASSWORD is rejected with an auth message" 1 "$rc"; grep -q 'cannot authenticate' "$WORK/g1.log" || bad "auth failure message missing"
backup_run "$TOOLS_IMAGE" /usr/local/bin/backup.sh >"$WORK/g2.log" 2>&1; rc=$?
expect "no recipients file and no plaintext opt-in is refused" 1 "$rc"
backup_run -v "$WORK/identity:/run/secrets/age.key:ro" "$TOOLS_IMAGE" /usr/local/bin/backup.sh >"$WORK/g3.log" 2>&1; rc=$?
expect "a private identity mounted as the recipients file is refused" 1 "$rc"; grep -q 'PRIVATE age identity' "$WORK/g3.log" || bad "private-identity message missing"
[[ -z "$(ls "$WORK/backups" | grep -E '^rcab-')" ]] && ok "failed runs left no partial backup files" || bad "partial backup files left behind"

# ── real runs: encrypted, with offsite (env-only local-backend remote) ───────
step "backup run 1 (encrypted + offsite + forced monthly)"
RC_ENV=(-e RCLONE_REMOTE=offsite -e RCLONE_BUCKET=/offsite -e RCLONE_PREFIX=rcab
        -e RCLONE_CONFIG_OFFSITE_TYPE=local -e BACKUP_FORCE_MONTHLY=1 -v "$WORK/offsite:/offsite")
backup_run "${RC_ENV[@]}" -v "$WORK/recipient.pub:/run/secrets/age.key:ro" \
  "$TOOLS_IMAGE" /usr/local/bin/backup.sh >"$WORK/b1.log" 2>&1; rc=$?
expect "backup run 1 succeeds" 0 "$rc"; [[ "$rc" != 0 ]] && tail -5 "$WORK/b1.log" >&2
sleep 1
newest="$(ls -1 "$WORK/backups" | grep -E '\.dump\.age$' | sort | tail -1)"
base="${newest%.dump.age}"
if [[ -n "$newest" && -f "$WORK/backups/$newest.sha256" && -f "$WORK/backups/$base.manifest.json" ]]; then
  ok "dump + .sha256 + manifest written ($newest)"; else bad "backup artefacts missing"; fi
head -c 22 "$WORK/backups/$newest" | grep -q 'age-encryption.org/v1' && ok "dump is age-encrypted (no plaintext on the volume)" || bad "dump is not age-encrypted"
[[ -z "$(find "$WORK/backups" -name '*.dump' -o -name '.tmp-*' | head -1)" ]] && ok "no plaintext dump or temp directory left on the volume" || bad "plaintext/temp files left on the volume"
[[ -f "$WORK/offsite/rcab/daily/$newest" && -f "$WORK/offsite/rcab/monthly/$newest" && -f "$WORK/offsite/rcab/daily/$base.manifest.json" ]] \
  && ok "offsite daily + monthly copies uploaded and verified" || bad "offsite copies missing"
[[ -f "$WORK/backups/.last_offsite_success" ]] && ok ".last_offsite_success recorded" || bad ".last_offsite_success missing"

# ── retention ───────────────────────────────────────────────────────────────
step "retention (synthetic old backups, KEEP_DAILY=2 KEEP_MONTHLY=2)"
for t in 20250101-000000 20250115-000000 20250201-000000 20250210-000000; do
  : > "$WORK/backups/rcab-$t.dump.age"; : > "$WORK/backups/rcab-$t.dump.age.sha256"; : > "$WORK/backups/rcab-$t.manifest.json"
done
step "backup run 2 (triggers prune)"
backup_run -e BACKUP_KEEP_DAILY=2 -e BACKUP_KEEP_MONTHLY=2 -v "$WORK/recipient.pub:/run/secrets/age.key:ro" \
  "$TOOLS_IMAGE" /usr/local/bin/backup.sh >"$WORK/b2.log" 2>&1; rc=$?
expect "backup run 2 succeeds" 0 "$rc"
left="$(ls -1 "$WORK/backups" | grep -E '\.dump\.age$' | tr '\n' ' ')"
if [[ ! -e "$WORK/backups/rcab-20250101-000000.dump.age" && ! -e "$WORK/backups/rcab-20250115-000000.dump.age" \
   && ! -e "$WORK/backups/rcab-20250115-000000.manifest.json" && ! -e "$WORK/backups/rcab-20250115-000000.dump.age.sha256" \
   && -e "$WORK/backups/rcab-20250201-000000.dump.age" && ! -e "$WORK/backups/rcab-20250210-000000.dump.age" ]]; then
  ok "retention removed 2025-01 (outside 2 months) and the non-first Feb backup; kept first-of-month + newest ($left)"
else bad "retention result unexpected: $left"; fi
rm -f -- "${WORK:?}"/backups/rcab-2025*   # synthetic files are empty: drop them before restoring

# ── restore drills ──────────────────────────────────────────────────────────
step "restore drill: local copy (latest)"
scripts/recovery/restore-drill.sh --dir "$WORK/backups" --identity "$WORK/identity" > "$WORK/drill-local.txt" 2>"$WORK/drill-local.err"; rc=$?
expect "restore drill on the local backup" 0 "$rc"; cat "$WORK/drill-local.txt"; [[ "$rc" != 0 ]] && tail -5 "$WORK/drill-local.err" >&2

step "restore drill: offsite copy"
scripts/recovery/restore-drill.sh --dir "$WORK/offsite/rcab/daily" --identity "$WORK/identity" > "$WORK/drill-off.txt" 2>"$WORK/drill-off.err"; rc=$?
expect "restore drill on the offsite (retrieved) copy" 0 "$rc"; [[ "$rc" != 0 ]] && { cat "$WORK/drill-off.txt"; tail -5 "$WORK/drill-off.err" >&2; }

step "restore drill: wrong identity must fail"
docker run --rm --entrypoint age-keygen "$TOOLS_IMAGE" 2>/dev/null > "$WORK/identity.wrong"
scripts/recovery/restore-drill.sh --dir "$WORK/backups" --identity "$WORK/identity.wrong" >"$WORK/drill-wrongkey.txt" 2>&1; rc=$?
expect "wrong age identity is detected" 1 "$rc"

step "restore drill: corrupted backup must fail"
mkdir -p "$WORK/corrupt"
cp "$WORK"/backups/rcab-* "$WORK/corrupt/"
f="$(ls -1 "$WORK"/corrupt/*.dump.age | tail -1)"
printf 'X' | dd of="$f" bs=1 seek=100 conv=notrunc 2>/dev/null
scripts/recovery/restore-drill.sh --dir "$WORK/corrupt" --identity "$WORK/identity" >"$WORK/drill-corrupt.txt" 2>&1; rc=$?
expect "corrupted dump is rejected by the integrity check" 1 "$rc"; grep -q 'integrity' "$WORK/drill-corrupt.txt" || bad "corruption not reported as an integrity failure"

echo
echo "================ BACKUP REHEARSAL SUMMARY ================"
printf '%s\n' "${RESULTS[@]}"
echo "----------------------------------------------------------"
if [[ "$FAILS" -gt 0 ]]; then echo "RESULT: FAIL ($FAILS)"; exit 1; fi
echo "RESULT: PASS (${#RESULTS[@]} checks)"
