#!/usr/bin/env bash
# The core read-only commands of .claude/skills/pool-inspect, as one runnable script (used by the M06 video).
cd "$(dirname "$0")/../../../.." || exit 2
RC() { docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T redis redis-cli "$@"; }
PSQL() { docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T postgres psql -U rcab -d rcab "$@"; }
echo "# Postgres is the truth: shared_rides"
PSQL -c "SELECT left(ride_id::text,8) AS ride, pool_state, seat_count, max_seats, state_version AS ver, dispatch_generation AS gen, left(claimed_by_driver_id::text,8) AS driver FROM shared_rides ORDER BY created_at DESC LIMIT 5;"
echo "# members"
PSQL -c "SELECT left(pool_id::text,8) AS pool, left(passenger_id::text,8) AS pax, seats, active, agreed_fare_cents AS fare FROM pool_member ORDER BY joined_at DESC LIMIT 5;"
echo "# pool state machine as it exists in the schema"
PSQL -c "SELECT pool_state, count(*) FROM shared_rides GROUP BY 1 ORDER BY 2 DESC;"
echo "# Redis projection + matching queue"
echo "pool:* keys      : $(RC --scan --pattern 'pool:*' | wc -l | tr -d ' ')"
echo "matching queue   : wait=$(RC LLEN bull:matching:wait) active=$(RC LLEN bull:matching:active) delayed=$(RC ZCARD bull:matching:delayed) failed=$(RC ZCARD bull:matching:failed)"
