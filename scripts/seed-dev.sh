#!/usr/bin/env bash
# Seed the dev database + Redis with fixture drivers/clients for manual testing.
#
# Runs entirely through `docker compose exec` (postgres + redis), so it needs no
# host-side pg/redis client and no published host ports.
#
# Usage:
#   scripts/seed-dev.sh                 # upsert the default fixture set
#   scripts/seed-dev.sh --reset         # delete previously seeded rows first
#   scripts/seed-dev.sh --drivers 10    # how many online drivers (default 3)
#   scripts/seed-dev.sh --offline       # seed drivers but leave them offline (no Redis geo)
#   scripts/seed-dev.sh --keepalive     # seed, then hold the drivers online (foreground, ^C to stop)
#
# Limits (read before trusting a demo to this):
#   * Seeded users have synthetic firebase_uid values (`seed-*`). They CANNOT sign in
#     through Firebase phone OTP. They exist so dispatch/matching/pool code has
#     candidates to find, and so list/earnings/history screens have data.
#   * To ACCEPT an offer you still need a real driver signed in on the Flutter app —
#     accept travels over that driver's WebSocket.
#   * The api runs an auto-offline sweep every 15 s and drops any driver whose
#     `driver:state:<id>.last_seen` is older than 60 s. Seeded drivers never heartbeat on
#     their own, so they fall out of the geo index about a minute after seeding. Use
#     --keepalive while you need them present.
set -euo pipefail

cd "$(dirname "$0")/.."

DC=(docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml)
PGU="${POSTGRES_USER:-rcab}"
PGD="${POSTGRES_DB:-rcab}"

DRIVERS=3
RESET=0
ONLINE=1
KEEPALIVE=0
KEEPALIVE_INTERVAL=20
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)   RESET=1 ;;
    --offline) ONLINE=0 ;;
    --keepalive) KEEPALIVE=1 ;;
    --drivers) DRIVERS="${2:?--drivers needs a number}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

status=$("${DC[@]}" ps postgres --format '{{.Status}}' 2>/dev/null || true)
case "$status" in
  *Up*) : ;;
  *) echo "[seed] postgres is not up (status: ${status:-none}). Run: pnpm dev:up" >&2; exit 1 ;;
esac

psql() { "${DC[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PGU" -d "$PGD" "$@"; }
redis() { "${DC[@]}" exec -T redis redis-cli "$@"; }

# Guwahati — must stay inside the NE-India OSRM extract or routing returns NoRoute.
BASE_LAT=26.1445
BASE_LNG=91.7362

if [[ "$RESET" == 1 ]]; then
  echo "[seed] deleting previously seeded rows (firebase_uid LIKE 'seed-%')"
  psql -q <<'SQL'
DELETE FROM ratings WHERE rater_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'seed-%')
   OR subject_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'seed-%');
DELETE FROM rides WHERE passenger_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'seed-%');
DELETE FROM app_user WHERE firebase_uid LIKE 'seed-%';
SQL
  # Seeded driver ids are deterministic (…0000000000NN) — clear their Redis state/geo.
  for n in $(seq 1 50); do
    id=$(printf '00000000-0000-4000-8000-0000000000%02d' "$n")
    redis ZREM active_drivers "$id" >/dev/null
    redis DEL "driver:state:$id" >/dev/null
  done
fi

echo "[seed] upserting $DRIVERS driver(s) + 2 client(s)"

# Deterministic uuids: 00000000-0000-4000-8000-0000000000NN (drivers), ...01NN (clients).
psql -q <<SQL
DO \$\$
DECLARE
  n int;
  uid uuid;
  vid uuid;
  types text[] := ARRAY['auto','cab_hatch','cab_sedan','bike'];
  seatmap int[]  := ARRAY[3,4,4,1];
  t int;
BEGIN
  FOR n IN 1..$DRIVERS LOOP
    uid := ('00000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid;
    vid := ('00000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid;
    t := ((n - 1) % 4) + 1;

    INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status)
    VALUES (uid, 'seed-driver-' || n, '+9199000000' || lpad(n::text, 2, '0'),
            'Seed Driver ' || n, 'driver', 'active')
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

    INSERT INTO driver (user_id, license_no, verified_at, availability)
    VALUES (uid, 'SEEDLIC' || lpad(n::text, 4, '0'), now(), 'offline')
    ON CONFLICT (user_id) DO UPDATE SET verified_at = now();

    INSERT INTO vehicle (id, driver_id, type, reg_no, make, model, color, seats, active)
    VALUES (vid, uid, types[t], 'AS01' || lpad(n::text, 4, '0'),
            'Seed', 'Fixture', 'white', seatmap[t], true)
    ON CONFLICT (id) DO UPDATE SET active = true;

    UPDATE driver SET current_vehicle_id = vid WHERE user_id = uid;
  END LOOP;

  FOR n IN 1..2 LOOP
    uid := ('00000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid;
    INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status)
    VALUES (uid, 'seed-client-' || n, '+9199000001' || lpad(n::text, 2, '0'),
            'Seed Client ' || n, 'client', 'active')
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    INSERT INTO client (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  END LOOP;
END
\$\$;
SQL

if [[ "$ONLINE" == 1 ]]; then
  echo "[seed] putting drivers in the Redis geo index around ($BASE_LAT, $BASE_LNG)"
  for n in $(seq 1 "$DRIVERS"); do
    id=$(printf '00000000-0000-4000-8000-0000000000%02d' "$n")
    lat=$(awk -v b="$BASE_LAT" -v i="$n" 'BEGIN{printf "%.6f", b + (i%5)*0.004 - 0.008}')
    lng=$(awk -v b="$BASE_LNG" -v i="$n" 'BEGIN{printf "%.6f", b + (i%7)*0.004 - 0.012}')
    redis GEOADD active_drivers "$lng" "$lat" "$id" >/dev/null
    redis HSET "driver:state:$id" availability online last_seen "$(date +%s)000" session_id "seed-$n" >/dev/null
  done
  psql -q -c "UPDATE driver SET availability='online' WHERE user_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'seed-driver-%');"
fi

echo
echo "Seed complete"
echo "─────────────"
psql -P pager=off -c "SELECT role, count(*) FROM app_user WHERE firebase_uid LIKE 'seed-%' GROUP BY role ORDER BY role;"
psql -P pager=off -c "SELECT u.display_name, u.phone_e164, d.availability, v.type, v.reg_no
  FROM app_user u JOIN driver d ON d.user_id = u.id
  LEFT JOIN vehicle v ON v.id = d.current_vehicle_id
  WHERE u.firebase_uid LIKE 'seed-driver-%' ORDER BY u.display_name;"
echo "Redis geo members: $(redis ZCARD active_drivers | tr -d '\r')"
echo
echo "Reminder: seeded users cannot sign in via Firebase OTP — they are dispatch"
echo "candidates and screen data only. Accepting an offer needs a real signed-in driver."

if [[ "$ONLINE" == 1 && "$KEEPALIVE" == 0 ]]; then
  echo
  echo "NOTE: the api auto-offline sweep drops drivers silent for 60 s. Re-run this script,"
  echo "      or use --keepalive, to keep them in the geo index."
fi

if [[ "$KEEPALIVE" == 1 ]]; then
  if [[ "$ONLINE" == 0 ]]; then
    echo "[seed] --keepalive has nothing to do with --offline" >&2
    exit 2
  fi
  echo
  echo "[seed] keepalive: refreshing last_seen every ${KEEPALIVE_INTERVAL}s — ^C to stop"
  trap 'echo; echo "[seed] keepalive stopped; drivers go offline within 60s"; exit 0' INT TERM
  while true; do
    sleep "$KEEPALIVE_INTERVAL"
    for n in $(seq 1 "$DRIVERS"); do
      id=$(printf '00000000-0000-4000-8000-0000000000%02d' "$n")
      redis HSET "driver:state:$id" last_seen "$(date +%s)000" >/dev/null
    done
    printf '.'
  done
fi
