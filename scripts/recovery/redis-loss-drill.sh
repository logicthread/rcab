#!/usr/bin/env bash
# Redis-loss drill (RCAB-E8.S3, guide R13): prove Redis is rebuildable from Postgres.
#
# Policy under test: Redis loss affects AVAILABILITY only. Postgres is the authority;
# every Redis key is a projection, a timer, or advisory presence. After FLUSHALL + an api
# restart, the boot-time reconcilers must rebuild:
#   * pool:<id> projection hashes                     (PoolProjectionService.rebuildAll)
#   * BullMQ timers/jobs from the outbox + trip rows  (DispatchReconciler: scheduled wake,
#     pool expiry, dispatch start / wave-2 / hard-fail timers)
#   * driver:state:<id>.current_ride_id               (DriverAssignmentProjection), once the
#     driver is present again
# and drivers must be able to re-establish presence (POST /v1/drivers/online, as the app does).
#
# Runs against its OWN disposable compose project (infra/docker/docker-compose.recovery-drill.yml:
# own network, tmpfs Postgres, Redis without persistence, loopback-only high ports). It never
# touches the running dev stack. Exit 0 = all checks pass, 1 = a check failed, 2 = environment.
#
# Usage: scripts/recovery/redis-loss-drill.sh [--keep] [--api-port N] [--pg-port N] [--redis-port N]
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2
COMPOSE_FILE="$REPO_ROOT/infra/docker/docker-compose.recovery-drill.yml"

KEEP=0
API_PORT="${DRILL_API_PORT:-13000}"; PG_PORT="${DRILL_PG_PORT:-15432}"; REDIS_PORT="${DRILL_REDIS_PORT:-16379}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --api-port) API_PORT="${2:?}"; shift ;;
    --pg-port) PG_PORT="${2:?}"; shift ;;
    --redis-port) REDIS_PORT="${2:?}"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$API_PORT" "$PG_PORT" "$REDIS_PORT"; do
  if port_busy "$p"; then echo "host port $p is already in use; pass --api-port/--pg-port/--redis-port" >&2; exit 2; fi
done

PROJECT="rcab-drill-redis-$(date +%H%M%S)-$$"
JWT_SECRET_VALUE="$(openssl rand -hex 24)"
# Throwaway Firebase "service account": the api parses it at boot but never contacts Firebase.
KEY_PEM="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)" || { echo "openssl is required" >&2; exit 2; }
KEY_ESC="$(printf '%s\n' "$KEY_PEM" | awk 'BEGIN{ORS="\\n"} {print}')"
FIREBASE_JSON="{\"type\":\"service_account\",\"project_id\":\"rcab-drill\",\"client_email\":\"drill@rcab-drill.iam.invalid\",\"private_key\":\"${KEY_ESC}\"}"
export DRILL_API_PORT="$API_PORT" DRILL_PG_PORT="$PG_PORT" DRILL_REDIS_PORT="$REDIS_PORT" DRILL_JWT_SECRET="$JWT_SECRET_VALUE" DRILL_FIREBASE_JSON="$FIREBASE_JSON"
DC=(docker compose -p "$PROJECT" -f "$COMPOSE_FILE")

PASSES=0; FAILS=0; REPORT=()
pass() { PASSES=$((PASSES + 1)); REPORT+=("[PASS] $*"); }
fail() { FAILS=$((FAILS + 1)); REPORT+=("[FAIL] $*"); }
info() { REPORT+=("[INFO] $*"); }
say()  { echo "[redis-drill] $*" >&2; }

teardown() {
  if [[ "$KEEP" == 1 ]]; then
    say "kept project $PROJECT (api http://127.0.0.1:$API_PORT); remove with: docker compose -p $PROJECT -f $COMPOSE_FILE down -v"
  else
    "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1
  fi
}
trap teardown EXIT

pg()   { "${DC[@]}" exec -T postgres psql -X -U rcab -d rcab -At -v ON_ERROR_STOP=1 "$@"; }
rcli() { "${DC[@]}" exec -T redis redis-cli "$@"; }
rexists() { [[ "$(rcli EXISTS "$1" | tr -d '\r')" == "1" ]]; }
# wait_for SECONDS DESCRIPTION CMD...  -> 0 when CMD succeeds within SECONDS
wait_for() {
  local secs="$1" desc="$2"; shift 2
  local end=$(( $(date +%s) + secs ))
  while (( $(date +%s) < end )); do "$@" >/dev/null 2>&1 && return 0; sleep 2; done
  say "timed out after ${secs}s waiting for: $desc"
  return 1
}

A=fa000000-0000-4000-8000-00000000000a   # solo, dispatching on generation 1
B=fa000000-0000-4000-8000-00000000000b   # scheduled, not yet woken
P=fa000000-0000-4000-8000-00000000000f   # open pool
E=fa000000-0000-4000-8000-00000000000e   # accepted by D1 (guard row)
D1=fa000000-0000-4000-8000-000000000d01
D2=fa000000-0000-4000-8000-000000000d02

mint_token() { # driver id -> access token (HS256, same claims the api issues)
  "${DC[@]}" exec -T -e DRIVER_ID="$1" api node -e '
    const c = require("crypto"), b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const h = b({ alg: "HS256", typ: "JWT" });
    const p = b({ sub: process.env.DRIVER_ID, role: "driver", auth_method: "drill", typ: "access",
                  iss: "rcab", aud: "rcab-api", iat: now, exp: now + 900 });
    process.stdout.write(h + "." + p + "." + c.createHmac("sha256", process.env.JWT_SECRET).update(h + "." + p).digest("base64url"));'
}
go_online() { # driver id -> http status
  local tok; tok="$(mint_token "$1")"
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$API_PORT/v1/drivers/online" \
    -H "Authorization: Bearer $tok" -H 'content-type: application/json' -d '{"lat":26.1445,"lng":91.7362}'
}
seed_presence() { # what a connected driver app leaves in Redis before the loss
  local d="$1"
  rcli HSET "driver:state:$d" availability online last_seen "$(date +%s)000" session_id "drill-$d" >/dev/null
  rcli GEOADD active_drivers 91.7362 26.1445 "$d" >/dev/null
}
authority_checksum() { # Postgres facts a Redis loss must not change
  pg -c "SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
           SELECT 'ride:' || id || ':' || status || ':' || COALESCE(driver_id::text,'') || ':' || dispatch_generation FROM rides WHERE id IN ('$B','$E')
           UNION ALL SELECT 'pool:' || ride_id || ':' || pool_state || ':' || seat_count || ':' || dispatch_generation FROM shared_rides
           UNION ALL SELECT 'member:' || pool_id || ':' || passenger_id || ':' || active FROM pool_member
           UNION ALL SELECT 'guard:' || driver_id || ':' || COALESCE(solo_ride_id::text, shared_ride_id::text) FROM driver_active_assignment
         ) s(x)"
}

# ── 1. disposable stack ──────────────────────────────────────────────────────
say "project $PROJECT: api :$API_PORT postgres :$PG_PORT redis :$REDIS_PORT (loopback)"
"${DC[@]}" up -d --wait postgres redis >/dev/null 2>&1 || { say "postgres/redis failed to start"; "${DC[@]}" logs --tail 30 >&2; exit 2; }
say "applying migrations (src/migrate.ts) and loading fixture"
"${DC[@]}" run --rm --no-deps -T api npx tsx src/migrate.ts 2>&1 | tail -3 >&2
[[ "${PIPESTATUS[0]}" == 0 ]] || { say "migration run failed"; exit 2; }
pg -f - < scripts/recovery/fixture.sql >/dev/null || { say "fixture load failed"; exit 2; }
pass "disposable stack up; migrations applied; fixture loaded ($(pg -c 'SELECT count(*) FROM rides') rides, $(pg -c 'SELECT count(*) FROM shared_rides') pool, $(pg -c 'SELECT count(*) FROM driver_active_assignment') guard)"

# Drivers present in Redis before the api boots, like drivers connected to a healthy stack.
seed_presence "$D1"; seed_presence "$D2"
say "starting api"
"${DC[@]}" up -d api >/dev/null 2>&1
wait_for 150 "api healthy" curl -sf "http://127.0.0.1:$API_PORT/v1/health/live" || { "${DC[@]}" logs --tail 40 api >&2; echo "RESULT: FAIL (api did not become healthy)"; exit 1; }

# ── 2. baseline (healthy steady state) ───────────────────────────────────────
say "baseline: waiting for the reconciler/projections to settle"
keepalive() { seed_presence "$D1"; seed_presence "$D2"; }
settled() { keepalive; rexists "pool:$P" && rexists "bull:matching:pool-expire-$P" && rexists "bull:scheduled-dispatch:scheduled-wake-$B-g1" \
            && [[ "$(rcli HGET "driver:state:$D1" current_ride_id | tr -d '\r')" == "$E" ]]; }
if wait_for 90 "baseline projections and timers" settled; then
  pass "baseline: pool:<P> hash, pool-expire + scheduled-wake jobs exist and D1.current_ride_id = E"
else
  fail "baseline never settled (pool hash:$(rexists "pool:$P" && echo y || echo n) expire:$(rexists "bull:matching:pool-expire-$P" && echo y || echo n) wake:$(rexists "bull:scheduled-dispatch:scheduled-wake-$B-g1" && echo y || echo n) D1.current_ride_id=$(rcli HGET "driver:state:$D1" current_ride_id | tr -d '\r'))"
fi
dispatch_keys_before="$(rcli --scan --pattern "bull:dispatch:*$A*" | tr -d '\r' | wc -l | tr -d ' ')"
info "baseline: ride A has $dispatch_keys_before dispatch key(s) in Redis; $(pg -c "SELECT count(*) FROM dispatch_offer WHERE ride_id='$A'") offer row(s) in Postgres"
BEFORE_SUM="$(authority_checksum)"

# ── 3. the loss ──────────────────────────────────────────────────────────────
say "LOSS: stop api, FLUSHALL redis, verify empty"
"${DC[@]}" stop api >/dev/null 2>&1
FLUSH_AT="$(pg -c 'SELECT clock_timestamp()')"
rcli FLUSHALL >/dev/null
keys_after_flush="$(rcli DBSIZE | tr -d '\r' | awk '{print $NF}')"
[[ "$keys_after_flush" == "0" ]] && pass "FLUSHALL: Redis is empty (DBSIZE 0)" || fail "Redis not empty after FLUSHALL (DBSIZE $keys_after_flush)"
[[ "$(authority_checksum)" == "$BEFORE_SUM" ]] && pass "Postgres authority unchanged by the loss" || fail "Postgres authority changed during the loss"

say "RECOVERY: start api (boot reconcilers run)"
"${DC[@]}" start api >/dev/null 2>&1
wait_for 150 "api healthy after restart" curl -sf "http://127.0.0.1:$API_PORT/v1/health/live" || { "${DC[@]}" logs --tail 40 api >&2; fail "api did not recover"; }

# ── 4. verify rebuild from Postgres ──────────────────────────────────────────
pool_ok() { [[ "$(rcli HGET "pool:$P" state | tr -d '\r')" == "open" && "$(rcli HGET "pool:$P" seat_count | tr -d '\r')" == "1" ]]; }
if wait_for 60 "pool projection" pool_ok; then pass "pool:<P> hash rebuilt from shared_rides + pool_member (state=open, seat_count=1, version=$(rcli HGET "pool:$P" version | tr -d '\r'))"; else fail "pool:<P> projection not rebuilt"; fi

if wait_for 90 "pool expiry job" rexists "bull:matching:pool-expire-$P"; then pass "BullMQ pool-expire-<P> timer restored (matching queue)"; else fail "pool-expire timer not restored"; fi
if wait_for 90 "scheduled wake job" rexists "bull:scheduled-dispatch:scheduled-wake-$B-g1"; then pass "BullMQ scheduled-wake-<B>-g1 restored from the outbox (scheduled-dispatch queue)"; else fail "scheduled wake not restored"; fi

dispatch_back() {
  [[ "$(rcli --scan --pattern "bull:dispatch:*$A*" | tr -d '\r' | wc -l | tr -d ' ')" -gt 0 ]] \
  || [[ "$(pg -c "SELECT count(*) FROM dispatch_offer WHERE ride_id='$A' AND offered_at > '$FLUSH_AT'")" -gt 0 ]]
}
if wait_for 90 "dispatch work for ride A" dispatch_back; then
  pass "dispatch work for ride A restored: $(rcli --scan --pattern "bull:dispatch:*$A*" | tr -d '\r' | sed "s/bull:dispatch://; s/$A/<A>/" | sort | tr '\n' ' ')"
else
  fail "no dispatch job/timer for ride A after the loss"
fi
republished="$(pg -c "SELECT count(*) FROM outbox WHERE processed_at > '$FLUSH_AT' AND aggregate_id IN ('$A','$B','$P')")"
[[ "$republished" -gt 0 ]] && pass "outbox intents re-armed and republished after the flush ($republished rows reprocessed)" \
                           || info "no outbox row was reprocessed (timers restored directly by the reconciler)"
log_line="$("${DC[@]}" logs --no-color api 2>/dev/null | grep -m1 -E 'reconcile repaired missing durable work|pool projection rebuilt from Postgres' | sed 's/^[^|]*| *//' | cut -c1-260)"
[[ -n "$log_line" ]] && info "api log: $log_line" || info "api log: no reconcile/rebuild line found (the checks above read Redis directly)"

# presence is advisory: gone until drivers re-announce themselves
presence_now="$(rcli EXISTS "driver:state:$D1" | tr -d '\r')"
[[ "$presence_now" == "0" ]] && info "presence after restart: driver:state:<D1> absent, as designed (advisory, rebuilt by the driver app)" \
                              || info "presence after restart: driver:state:<D1> already present"
s1="$(go_online "$D1")"; s2="$(go_online "$D2")"
if [[ "$s1" == 2* && "$s2" == 2* ]] && [[ "$(rcli ZCARD active_drivers | tr -d '\r')" -ge 2 ]]; then
  pass "drivers re-established presence via POST /v1/drivers/online (HTTP $s1/$s2; active_drivers = $(rcli ZCARD active_drivers | tr -d '\r'))"
else
  fail "drivers could not re-establish presence (HTTP $s1/$s2)"
fi
cur() { rcli HGET "driver:state:$D1" current_ride_id | tr -d '\r'; }
proj_back() { [[ "$(cur)" == "$E" ]]; }
if wait_for 70 "current_ride_id re-projection" proj_back; then
  pass "driver:state:<D1>.current_ride_id re-projected from driver_active_assignment (= ride E)"
else
  fail "current_ride_id not re-projected (got '$(cur)')"
fi
[[ "$(authority_checksum)" == "$BEFORE_SUM" ]] && pass "Postgres authority still identical after full recovery" || fail "Postgres authority differs after recovery"

# ── 5. report ────────────────────────────────────────────────────────────────
echo
echo "================ REDIS LOSS DRILL REPORT ================"
echo "project : $PROJECT (disposable; dev stack untouched)"
echo "loss    : FLUSHALL at $FLUSH_AT, api restarted"
echo "---------------------------------------------------------"
printf '%s\n' "${REPORT[@]}"
echo "---------------------------------------------------------"
if [[ "$FAILS" -gt 0 ]]; then echo "RESULT: FAIL ($FAILS failed, $PASSES passed)"; exit 1; fi
echo "RESULT: PASS ($PASSES passed)"
