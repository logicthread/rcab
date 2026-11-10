#!/usr/bin/env bash
# The core read-only commands of .claude/skills/redis-inspect, as one runnable script (used by the M06 video).
cd "$(dirname "$0")/../../../.." || exit 2
RC() { docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T redis redis-cli "$@"; }
echo "# reachable?";                     RC PING
echo "# driver presence (geo index)";   echo "active_drivers: $(RC ZCARD active_drivers)"
RC ZRANGE active_drivers 0 2
echo "# per-driver state hash (first driver:state:*)"
k="$(RC --scan --pattern 'driver:state:*' | head -1)"; echo "$k"; [ -n "$k" ] && RC HGETALL "$k" | paste - -
echo "# BullMQ queue depths"
for q in dispatch matching scheduled-dispatch; do
  echo "$q wait=$(RC LLEN bull:$q:wait) active=$(RC LLEN bull:$q:active) delayed=$(RC ZCARD bull:$q:delayed) failed=$(RC ZCARD bull:$q:failed)"
done
echo "# caches and totals"
echo "pool projections : $(RC --scan --pattern 'pool:*' | wc -l | tr -d ' ')"
echo "osrm polylines   : $(RC --scan --pattern 'osrm:poly:*' | wc -l | tr -d ' ')"
RC INFO keyspace | tail -n +2
