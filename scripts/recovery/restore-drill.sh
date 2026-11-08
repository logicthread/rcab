#!/usr/bin/env bash
# Restore drill (RCAB-E8.S3): prove a backup is actually restorable and consistent.
#
#   pick backup -> verify sha256/manifest -> [decrypt] -> restore into a THROWAWAY
#   Postgres container (no network, tmpfs data, auto-removed) -> migration status
#   (+ apply pending migrations the way src/migrate.ts does) -> schema invariants
#   I1-I9 -> row counts -> PASS/FAIL report -> teardown.
#
# Never touches the running dev/prod stack: it only talks to its own container.
# Exit code: 0 = every check passed (warnings allowed), 1 = at least one FAIL,
# 2 = usage / environment problem.
#
# Usage:
#   scripts/recovery/restore-drill.sh [--dir DIR] [--backup FILE] [--identity FILE]
#                                     [--no-migrate] [--keep] [--image IMAGE]
#     --dir DIR        backup directory (default $BACKUP_DIR or /opt/rcab/backups); the newest
#                      backup that has a manifest is used
#     --backup FILE    a specific rcab-*.dump[.age] or rcab-*.manifest.json
#     --identity FILE  age private identity (default $AGE_IDENTITY_FILE); needed for *.age
#     --no-migrate     do not apply migrations that are pending in this checkout
#     --keep           leave the throwaway container running (prints its name)
#     --image IMAGE    Postgres image (default: the FROM line of infra/docker/postgres/Dockerfile)
#
# Requires: docker. `age` is taken from the host if installed, else from the backup tools image.
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/apps/api/migrations"

DIR="${BACKUP_DIR:-/opt/rcab/backups}"
BACKUP=""
IDENTITY="${AGE_IDENTITY_FILE:-}"
MIGRATE=1
KEEP=0
IMAGE=""
TOOLS_IMAGE="${BACKUP_TOOLS_IMAGE:-rcab-backup-tools:local}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="${2:?--dir needs a value}"; shift ;;
    --backup) BACKUP="${2:?--backup needs a value}"; shift ;;
    --identity) IDENTITY="${2:?--identity needs a value}"; shift ;;
    --no-migrate) MIGRATE=0 ;;
    --keep) KEEP=1 ;;
    --image) IMAGE="${2:?--image needs a value}"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon is not reachable" >&2; exit 2; }

if [[ -z "$IMAGE" ]]; then
  IMAGE="$(awk '/^FROM /{print $2; exit}' "$REPO_ROOT/infra/docker/postgres/Dockerfile")"
fi

PASSES=0; FAILS=0; WARNS=0
REPORT=()
pass() { PASSES=$((PASSES + 1)); REPORT+=("[PASS] $*"); }
fail() { FAILS=$((FAILS + 1)); REPORT+=("[FAIL] $*"); }
warn() { WARNS=$((WARNS + 1)); REPORT+=("[WARN] $*"); }
note() { echo "[drill] $*" >&2; }

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
json_field() { sed -n "s/^ *\"$2\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\} *$/\1/p" "$1" | head -1; }

RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
C="rcab-restore-drill-$RUN_ID"
T_START=$(date +%s)

teardown() {
  if [[ "$KEEP" == 1 ]]; then
    note "leaving container $C running (remove with: docker rm -f $C)"
  else
    docker rm -f "$C" >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

finish() {
  local total=$(( $(date +%s) - T_START ))
  echo
  echo "================ RESTORE DRILL REPORT ================"
  echo "backup      : ${FILE_NAME:-n/a}"
  [[ -n "${MANIFEST_CREATED:-}" ]] && echo "created_at  : $MANIFEST_CREATED (backup age at drill: ${AGE_HOURS:-?} h)"
  echo "postgres    : $IMAGE (throwaway, no network, data on tmpfs)"
  echo "restore time: ${RESTORE_SECS:-n/a} s   total drill time: ${total} s"
  echo "------------------------------------------------------"
  printf '%s\n' "${REPORT[@]}"
  echo "------------------------------------------------------"
  if [[ "$FAILS" -gt 0 ]]; then
    echo "RESULT: FAIL ($FAILS failed, $WARNS warnings, $PASSES passed)"
    exit 1
  fi
  echo "RESULT: PASS ($PASSES passed, $WARNS warnings)"
  exit 0
}

# ── 1. choose the backup ─────────────────────────────────────────────────────
MANIFEST=""
if [[ -n "$BACKUP" ]]; then
  [[ -f "$BACKUP" ]] || { echo "no such file: $BACKUP" >&2; exit 2; }
  DIR="$(cd "$(dirname "$BACKUP")" && pwd)"
  b="$(basename "$BACKUP")"; b="${b%.manifest.json}"; b="${b%.age}"; b="${b%.dump}"
  MANIFEST="$DIR/$b.manifest.json"
else
  [[ -d "$DIR" ]] || { echo "backup dir not found: $DIR" >&2; exit 2; }
  MANIFEST="$(ls -1 "$DIR"/rcab-*.manifest.json 2>/dev/null | sort | tail -1 || true)"
  if [[ -z "$MANIFEST" ]]; then
    fail "no complete backup (rcab-*.manifest.json) found in $DIR"
    finish
  fi
fi
if [[ ! -f "$MANIFEST" ]]; then
  fail "manifest missing: $MANIFEST (an incomplete backup must not be restored)"
  finish
fi
FILE_NAME="$(json_field "$MANIFEST" file)"
FILE="$DIR/$FILE_NAME"
MANIFEST_CREATED="$(json_field "$MANIFEST" created_at)"
MANIFEST_SHA="$(json_field "$MANIFEST" sha256)"
MANIFEST_SIZE="$(json_field "$MANIFEST" size_bytes)"
MANIFEST_LAST_MIG="$(json_field "$MANIFEST" last_migration)"
ENCRYPTED="$(json_field "$MANIFEST" encrypted)"
note "using $FILE_NAME"
if [[ -n "$MANIFEST_CREATED" ]]; then
  created_epoch="$(date -u -d "$MANIFEST_CREATED" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$MANIFEST_CREATED" +%s 2>/dev/null || echo "")"
  [[ -n "$created_epoch" ]] && AGE_HOURS=$(( ($(date +%s) - created_epoch) / 3600 ))
fi

# ── 2. integrity ─────────────────────────────────────────────────────────────
if [[ ! -f "$FILE" ]]; then
  fail "dump file listed in the manifest is missing: $FILE"
  finish
fi
actual_sha="$(sha256_of "$FILE")"
actual_size="$(wc -c < "$FILE" | tr -d ' ')"
sidecar_sha="$(awk '{print $1}' "$FILE.sha256" 2>/dev/null || true)"
if [[ "$actual_sha" == "$MANIFEST_SHA" && "$actual_size" == "$MANIFEST_SIZE" ]]; then
  pass "integrity: sha256 and size match the manifest ($actual_size bytes)"
else
  fail "integrity: dump does not match manifest (sha256 $actual_sha vs $MANIFEST_SHA; size $actual_size vs $MANIFEST_SIZE)"
  finish
fi
if [[ -n "$sidecar_sha" && "$sidecar_sha" != "$actual_sha" ]]; then
  fail "integrity: .sha256 sidecar disagrees with the dump"; finish
fi

# ── 3. decrypt helper ────────────────────────────────────────────────────────
decrypt() {
  if command -v age >/dev/null; then
    age -d -i "$IDENTITY"
  else
    docker run --rm -i -v "$IDENTITY:/identity:ro" --entrypoint age "$TOOLS_IMAGE" -d -i /identity
  fi
}
if [[ "$FILE" == *.age ]]; then
  if [[ -z "$IDENTITY" || ! -f "$IDENTITY" ]]; then
    fail "backup is age-encrypted but no identity file was given (--identity / AGE_IDENTITY_FILE)"
    finish
  fi
  if ! command -v age >/dev/null && ! docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1; then
    note "building $TOOLS_IMAGE (provides age) from infra/docker/backup"
    docker build -q -t "$TOOLS_IMAGE" "$REPO_ROOT/infra/docker/backup" >/dev/null || { fail "could not build $TOOLS_IMAGE"; finish; }
  fi
fi

# ── 4. throwaway Postgres ────────────────────────────────────────────────────
note "starting throwaway postgres ($IMAGE) as $C"
if ! docker run -d --name "$C" --network none --label rcab.recovery-drill="$RUN_ID" \
      --tmpfs /var/lib/postgresql/data:rw,size=2g -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=postgres \
      "$IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null; then
  fail "could not start $IMAGE"; finish
fi
ready=0
for _ in $(seq 1 180); do
  if docker logs "$C" 2>&1 | grep -q 'PostgreSQL init process complete' \
     && docker exec "$C" pg_isready -q -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { fail "throwaway postgres did not become ready in 180 s"; finish; }

DBNAME=rcab_restore
dbq() { docker exec -i "$C" psql -X -q -U postgres -d "$DBNAME" -v ON_ERROR_STOP=1 -At "$@"; }
docker exec "$C" createdb -U postgres "$DBNAME" || { fail "createdb failed"; finish; }

# ── 5. restore ───────────────────────────────────────────────────────────────
note "restoring (pg_restore --no-owner --no-privileges)"
T_RESTORE=$(date +%s)
RESTORE_LOG="$(mktemp)"
if [[ "$FILE" == *.age ]]; then
  decrypt < "$FILE" | docker exec -i "$C" pg_restore --no-owner --no-privileges -U postgres -d "$DBNAME" 2> "$RESTORE_LOG"
else
  docker exec -i "$C" pg_restore --no-owner --no-privileges -U postgres -d "$DBNAME" < "$FILE" 2> "$RESTORE_LOG"
fi
rc=$?
RESTORE_SECS=$(( $(date +%s) - T_RESTORE ))
if [[ "$rc" -eq 0 ]]; then
  pass "pg_restore completed with no errors (${RESTORE_SECS} s)"
else
  fail "pg_restore exited $rc: $(grep -m3 -i 'error' "$RESTORE_LOG" | tr '\n' ' ')"
  rm -f "$RESTORE_LOG"; finish
fi
rm -f "$RESTORE_LOG"

# Extensions come from the dump itself (pg_restore would have errored if the image lacked one).
ext="$(dbq -c "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname <> 'plpgsql'")"
pass "extensions restored: ${ext:-none besides plpgsql}"

# ── 6. migration status ──────────────────────────────────────────────────────
has_mig_table="$(dbq -c "SELECT to_regclass('public._rcab_migrations') IS NOT NULL")"
if [[ "$has_mig_table" != "t" ]]; then
  fail "migrations: _rcab_migrations table is absent from the restored database"
else
  APPLIED=(); REPO_MIGS=(); unknown=(); pending=()
  while IFS= read -r l; do [[ -n "$l" ]] && APPLIED+=("$l"); done < <(dbq -c "SELECT name FROM _rcab_migrations ORDER BY name")
  while IFS= read -r l; do [[ -n "$l" ]] && REPO_MIGS+=("$l"); done < <(cd "$MIGRATIONS_DIR" && ls -1 *.sql | sort)
  for a in "${APPLIED[@]}"; do printf '%s\n' "${REPO_MIGS[@]}" | grep -qx "$a" || unknown+=("$a"); done
  for r in "${REPO_MIGS[@]}"; do printf '%s\n' "${APPLIED[@]}" | grep -qx "$r" || pending+=("$r"); done
  last_applied="${APPLIED[${#APPLIED[@]}-1]:-none}"
  if [[ -n "$MANIFEST_LAST_MIG" && "$last_applied" != "$MANIFEST_LAST_MIG" ]]; then
    fail "migrations: restored history ends at $last_applied but the manifest recorded $MANIFEST_LAST_MIG"
  fi
  if [[ ${#unknown[@]} -gt 0 ]]; then
    fail "migrations: backup has migrations unknown to this checkout: ${unknown[*]} (restore with a newer release)"
  else
    pass "migrations: ${#APPLIED[@]} recorded, last = $last_applied; none unknown to this checkout"
  fi
  if [[ ${#pending[@]} -eq 0 ]]; then
    pass "migrations: nothing pending"
  elif [[ "$MIGRATE" == 0 ]]; then
    warn "migrations: ${#pending[@]} pending, not applied (--no-migrate): ${pending[*]}"
  else
    ok=1; migerr="$(mktemp)"
    for m in "${pending[@]}"; do
      if docker exec -i "$C" psql -X -q -U postgres -d "$DBNAME" -v ON_ERROR_STOP=1 --single-transaction -f - < "$MIGRATIONS_DIR/$m" >/dev/null 2> "$migerr"; then
        dbq -c "INSERT INTO _rcab_migrations (name) VALUES ('$m')" >/dev/null
      else
        fail "migrations: $m FAILED on the restored data: $(head -c 300 "$migerr" | tr '\n' ' ')"
        ok=0; break
      fi
    done
    rm -f "$migerr"
    [[ "$ok" == 1 ]] && pass "migrations: applied ${#pending[@]} pending (${pending[*]}) cleanly onto the restored data"
  fi
fi

has() { [[ "$(dbq -c "SELECT to_regclass('public.$1') IS NOT NULL")" == "t" ]]; }

# ── 7. open migration conflicts (operator work, not a drill failure) ─────────
if has migration_conflict; then
  open_conf="$(dbq -c "SELECT count(*) FROM migration_conflict WHERE resolved_at IS NULL")"
  if [[ "$open_conf" -gt 0 ]]; then
    kinds="$(dbq -c "SELECT string_agg(kind || ' x' || n, ', ') FROM (SELECT kind, count(*) n FROM migration_conflict WHERE resolved_at IS NULL GROUP BY kind) k")"
    warn "migration_conflict: $open_conf open row(s) need an operator decision ($kinds); see docs/operations/recovery-runbook.md section 6"
  else
    pass "migration_conflict: no open rows"
  fi
fi

# ── 8. invariants (docs/remediation/stage-c-contract.md section 6) ───────────
inv() { # name, sql ; every query must return zero rows
  local name="$1" sql="$2" out n
  if ! out="$(dbq -c "$sql" 2>&1)"; then fail "$name: query error: $(echo "$out" | head -c 200 | tr '\n' ' ')"; return; fi
  n="$(printf '%s' "$out" | grep -c . || true)"
  if [[ "$n" -eq 0 ]]; then pass "$name: 0 violations"; else fail "$name: $n violation(s), e.g. $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; fi
}

if ! has driver_active_assignment || ! has dispatch_offer || ! has outbox || ! has pool_member; then
  fail "invariants: Stage-C tables absent (backup predates 0014-0017 and migrations were not applied)"
else
  inv "I1  guard <=> active solo ride" "
SELECT r.id FROM rides r
 WHERE r.status IN ('accepted','en_route','arrived','in_progress')
   AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.solo_ride_id = r.id AND a.driver_id = r.driver_id)
UNION ALL
SELECT a.solo_ride_id FROM driver_active_assignment a JOIN rides r ON r.id = a.solo_ride_id
 WHERE r.status NOT IN ('accepted','en_route','arrived','in_progress') OR r.driver_id <> a.driver_id"
  inv "I2  guard <=> claimed non-terminal pool" "
SELECT s.ride_id FROM shared_rides s
 WHERE s.claimed_by_driver_id IS NOT NULL
   AND s.pool_state IN ('closed_full','closed_timeout','closed_started')
   AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.shared_ride_id = s.ride_id AND a.driver_id = s.claimed_by_driver_id)
UNION ALL
SELECT a.shared_ride_id FROM driver_active_assignment a JOIN shared_rides s ON s.ride_id = a.shared_ride_id
 WHERE s.pool_state IN ('open','aborted','completed') OR s.claimed_by_driver_id IS DISTINCT FROM a.driver_id"
  inv "I3  accepted offer is the current assignment" "
SELECT o.id FROM dispatch_offer o
 WHERE o.state = 'accepted'
   AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.offer_id = o.id)
   AND EXISTS (SELECT 1 FROM rides r WHERE r.id = o.ride_id AND r.status IN ('accepted','en_route','arrived','in_progress'))"
  inv "I4  no live offer on a non-claimable trip" "
SELECT o.id FROM dispatch_offer o LEFT JOIN rides r ON r.id = o.ride_id
  LEFT JOIN shared_rides s ON s.ride_id = o.shared_ride_id
 WHERE o.state = 'offered'
   AND ((r.id IS NOT NULL AND (r.status <> 'requested' OR r.dispatch_generation <> o.dispatch_generation))
     OR (s.ride_id IS NOT NULL AND (s.claimed_by_driver_id IS NOT NULL
                                    OR s.pool_state NOT IN ('closed_full','closed_timeout')
                                    OR s.dispatch_generation <> o.dispatch_generation)))"
  inv "I5  pool seat_count derived and within capacity" "
SELECT s.ride_id FROM shared_rides s
 WHERE s.seat_count <> (SELECT COALESCE(sum(m.seats),0) FROM pool_member m WHERE m.pool_id = s.ride_id)
    OR s.seat_count > s.max_seats"
  # I6: memberships already inventoried by 0016 as passenger_multiple_active_pools are expected until resolved.
  i6="$(dbq -c "
SELECT m.pool_id || '/' || m.passenger_id FROM pool_member m JOIN shared_rides s ON s.ride_id = m.pool_id
 WHERE m.active = (s.pool_state IN ('aborted','completed'))
   AND NOT EXISTS (SELECT 1 FROM migration_conflict c
                    WHERE c.kind = 'passenger_multiple_active_pools' AND c.resolved_at IS NULL
                      AND c.subject->>'passenger_id' = m.passenger_id::text)" 2>&1)"
  if [[ "$(printf '%s' "$i6" | grep -c . || true)" -eq 0 ]]; then pass "I6  membership active flag matches pool state: 0 violations"; else fail "I6  membership active flag: $(printf '%s' "$i6" | head -3 | tr '\n' ' ')"; fi
  inv "I7  closed pool has itinerary and dispatch intent" "
SELECT s.ride_id FROM shared_rides s
 WHERE s.pool_state IN ('closed_full','closed_timeout') AND s.dispatch_generation >= 1
   AND (NOT EXISTS (SELECT 1 FROM ride_stops t WHERE t.ride_id = s.ride_id)
        OR NOT EXISTS (SELECT 1 FROM outbox o WHERE o.topic = 'pool.dispatch.requested'
                         AND o.aggregate_id = s.ride_id AND o.aggregate_generation = s.dispatch_generation))"
  inv "I8  committed bookings have their outbox intent" "
SELECT r.id FROM rides r
 WHERE r.created_at >= COALESCE((SELECT ran_at FROM _rcab_migrations WHERE name = '0015_outbox.sql'), '-infinity')
   AND ((r.type = 'normal' AND r.dispatch_generation >= 1 AND NOT EXISTS (
          SELECT 1 FROM outbox o WHERE o.topic = 'ride.dispatch.requested' AND o.aggregate_id = r.id))
    OR (r.type = 'scheduled' AND r.status = 'requested' AND r.dispatch_generation = 0 AND NOT EXISTS (
          SELECT 1 FROM outbox o WHERE o.topic = 'ride.wake.schedule' AND o.aggregate_id = r.id)))"
  inv "I9a outbox: no exhausted rows" "SELECT id FROM outbox WHERE failed_at IS NOT NULL"
  # A restored backup is hours old by construction: stale = unprocessed for >5 min relative to the DUMP, not to now().
  inv "I9b outbox: no long-stalled intents" "
SELECT id FROM outbox WHERE processed_at IS NULL AND failed_at IS NULL
   AND available_at < (SELECT COALESCE(max(created_at), now()) FROM outbox) - interval '5 minutes'"
fi

# ── 9. row counts ────────────────────────────────────────────────────────────
counts="$(dbq -F ' = ' -c "
SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'spatial_ref_sys'
 ORDER BY table_name" 2>&1)"
ntables="$(printf '%s\n' "$counts" | grep -c ' = ' || true)"
total_rows="$(printf '%s\n' "$counts" | awk -F' = ' 'NF==2 {s+=$2} END {print s+0}')"
if [[ "$ntables" -gt 0 ]]; then
  pass "row counts: $ntables tables, $total_rows rows total"
  echo "------------------ row counts ------------------" >&2
  printf '%s\n' "$counts" | awk -F' = ' 'NF==2 {printf "  %-32s %s\n", $1, $2}' >&2
else
  fail "row counts: no tables found in the restored database"
fi
if has app_user; then
  [[ "$(dbq -c 'SELECT count(*) FROM app_user')" -gt 0 ]] && pass "sanity: app_user has rows" || warn "sanity: app_user is empty (is this an empty database?)"
fi

finish
