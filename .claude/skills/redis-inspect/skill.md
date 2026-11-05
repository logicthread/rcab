---
name: redis-inspect
description: Inspect Redis state across every namespace this project uses — driver presence/geo, dispatch offers and claims, shared-ride pools, OSRM polyline cache, idempotency keys, BullMQ queues. No args.
---

# redis-inspect

One pass over rcab's Redis state, with the **real** key names as written by the code.

Note: **JWT/refresh-token revocation is NOT in Redis** — it lives in Postgres
(`auth_refresh_token.revoked_at`). Don't look for a `revoked:*` set.

Define once:
```bash
RC() { docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T redis redis-cli "$@"; }
```

## Namespaces

| Namespace | Keys | Written by |
|---|---|---|
| Driver presence | `active_drivers` (GEO zset), `driver:state:<driverId>` (hash: `availability`, `last_seen`, `session_id`, `current_ride_id`) | `drivers.service`, `realtime.gateway` |
| Dispatch offers | `offer:<offerId>` → driverId, `offer:meta:<offerId>` → rideId, `offer:type:<offerId>` → `solo|pool`, `offer:list:<rideId>` (set) | `dispatch.service` |
| Ride claim locks | `claim:ride:<rideId>` (SET NX winner lock) | `dispatch.service` |
| Shared-ride pools | `pool:<rideId>` (hash: `seat_count`, …), `pool:<rideId>:seats` | `pool-lifecycle.service` |
| OSRM polyline cache | `osrm:poly:<geohash7>:<geohash7>` | `route-similarity.service` |
| Idempotency | `idem:rides:<Idempotency-Key>` | `rides.controller` |
| BullMQ | `bull:dispatch:*`, `bull:matching:*`, `bull:scheduled-dispatch:*` | dispatch / matching / scheduled modules |

## Steps

1. **Reachable?**
   ```bash
   RC PING
   ```

2. **Driver presence.**
   ```bash
   RC ZCARD active_drivers
   RC ZRANGE active_drivers 0 9
   RC GEOPOS active_drivers <driverId>
   RC --scan --pattern 'driver:state:*'
   RC HGETALL driver:state:<driverId>
   ```
   An empty `active_drivers` with drivers "online" in Postgres means the auto-offline sweep
   reaped them: the api drops any driver whose `last_seen` is older than **60 s**, checked
   every 15 s. Seeded fixtures need `./scripts/seed-dev.sh --keepalive`.

3. **In-flight dispatch.**
   ```bash
   RC --scan --pattern 'offer:*'
   RC --scan --pattern 'claim:ride:*'
   RC TTL offer:<offerId>        # offers carry a 12 s TTL
   ```

4. **Shared-ride pools** (detail in `/pool-inspect`).
   ```bash
   RC --scan --pattern 'pool:*'
   RC HGETALL pool:<rideId>
   ```

5. **BullMQ queue depths** — for each of `dispatch`, `matching`, `scheduled-dispatch`:
   ```bash
   for q in dispatch matching scheduled-dispatch; do
     echo "$q wait=$(RC LLEN bull:$q:wait) active=$(RC LLEN bull:$q:active) delayed=$(RC ZCARD bull:$q:delayed) failed=$(RC ZCARD bull:$q:failed)"
   done
   ```
   `bull:scheduled-dispatch:delayed` is where a scheduled ride's wake job waits (E6) —
   `ZRANGE … WITHSCORES` gives its fire time in Unix ms.

6. **Caches + totals.**
   ```bash
   RC --scan --pattern 'osrm:poly:*' | wc -l
   RC --scan --pattern 'idem:rides:*' | wc -l
   RC DBSIZE
   RC INFO keyspace
   ```

7. **Report a table** of namespace → count → sample, and call out anything unexpected
   (claims with no matching ride, offers with no TTL, a failed BullMQ set that isn't empty).

## Anti-patterns

- Don't `KEYS *` on a loaded instance — use `--scan --pattern`.
- Don't `FLUSHALL` to "clean up": it destroys BullMQ metadata and delayed wake jobs.
  Delete the specific keys, or `pnpm dev:down -v` for a true reset.
