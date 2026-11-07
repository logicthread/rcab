---
name: pool-inspect
description: Inspect the current state of all shared-ride pools in Redis — open pools, seat counts, expiry timers, and BullMQ queue depth. Useful during E5 development and demos. No args.
---

# pool-inspect

A targeted Redis/BullMQ inspector focused on the shared-ride matching state introduced in E5. More targeted than `/redis-inspect` which covers all namespaces.

## Inputs

None. Define the redis helper once — every command below goes through the container
(Redis is on host `6379` too, but `redis-cli` may not be installed on the host):

```bash
RC() { docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T redis redis-cli "$@"; }
```

## Steps

1. **List all open pools.**
   ```bash
   RC --scan --pattern 'pool:*' | grep -v ':seats' | sort
   ```
   Keys are `pool:<rideId>` (hash, TTL-bounded) and `pool:<rideId>:seats` (the Lua-guarded
   seat counter). For each pool hash:
   ```bash
   RC HGETALL pool:<rideId>
   RC GET pool:<rideId>:seats
   ```
   The authoritative pool row is in Postgres (`shared_rides`: `status`, `seat_count`,
   `claimed_by_driver_id`) — the Redis hash is the hot copy, so cross-check:
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T postgres \
     psql -U rcab -d rcab -c "SELECT id, status, seat_count, claimed_by_driver_id FROM shared_rides ORDER BY created_at DESC LIMIT 10;"
   ```

2. **Show pool expiry timers from BullMQ.**
   ```bash
   RC ZRANGEBYSCORE 'bull:matching:delayed' 0 +inf WITHSCORES | head -20
   ```
   Each entry is a `pool:expire:<rideId>` job with its Unix ms fire time. Show time remaining
   in human-readable form.

3. **Show BullMQ queue depths.**
   ```bash
   RC LLEN bull:matching:wait
   RC LLEN bull:matching:active
   RC ZCARD bull:matching:delayed
   RC ZCARD bull:matching:failed
   ```
   `dispatch` and `scheduled-dispatch` are separate queues — see `/redis-inspect` for those.

4. **Show cached route-similarity polylines.**
   ```bash
   RC --scan --pattern 'osrm:poly:*' | wc -l
   ```
   Keys are `osrm:poly:<geohash7-origin>:<geohash7-dest>`.
   Count only — listing all would be verbose.

5. **Print summary.**
   ```
   Shared-ride pool state
   ──────────────────────
   Open pools:        2
     pool:abc123 — seat 1/3, expires in 42s
     pool:def456 — seat 2/3, expires in 18s
   Closed pools:      1
     pool:ghi789 — closed_full, claimed_by drv_001
   BullMQ (matching): wait=0  active=0  delayed=2  failed=0
   OSRM poly cache:   14 keys
   ```

## When to use

- During E5 story development to verify pool state machine transitions
- During the Demo 4 walk-through to confirm pools open, fill, and close correctly
- When debugging a missed dispatch (check if pool closed without triggering dispatch)

## See also

- `/redis-inspect` — broader Redis inspection across all namespaces
- `/smoke-check` — overall stack health
