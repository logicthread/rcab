# Workflow: debugging and tooling

How to find out what the system is doing, quickly, with the tools already in the repo. Videos of most of these are
in the ops scenes: [M01–M06](../videos/ops/INDEX.md) (dashboards, Prometheus, Loki, Uptime Kuma, Alertmanager, and
terminal recordings of the dev tooling).

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"     # if pnpm/node are "not found" in a non-interactive shell
DC="docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml"
```

## 1. First five minutes: is the stack even healthy?

| Tool | Use |
|---|---|
| `/smoke-check` | Per-service table: containers (with the `obs` profile), endpoints, latency. Start here. |
| `pnpm dev:smoke` | Terse poll: api `/` returns 200 once Postgres and Redis are connected. |
| `/api-smoke` | `/v1/health/live`, `/v1/health/ready` (postgres, redis, osrm) with per-call latency. Run after restarting a module. |
| `curl localhost:3000/v1/health/version` | `{version, builtAt}`; in a release this must equal the deployed SHA. |
| `/osrm-check` | OSRM loaded its graph and can route a test pair. **Run before any dispatch/pool work**; no route means no quote and no pool pricing. |
| `/docker-stats` | CPU/memory per container against the Phase-0 VPS budget. |
| `/env-validate` | Diffs `.env*` against `env.example`; catches "container starts then crashes on a missing variable". |
| `/validate-compose` | All compose file combinations (dev, prod, prod-test) parse after you edit one. |
| `pnpm system:probe` | Host capability and load estimate (RCAB-E1.S9); the `test:probe` suite tests the probe itself. |

## 2. Logs

- `pnpm dev:logs` follows everything; `$DC logs -f api` one service. The api logs JSON via pino.
- **Request ids.** `RequestIdMiddleware` accepts or generates an `x-request-id` header and returns it on the
  response; the metrics middleware and the global exception filter log it as the `request_id` field. A user report
  that includes the id from the failed response gives you the whole story.
- **Loki (Grafana Explore, or the Logs dashboard).** Promtail ships Docker logs; only low-cardinality fields become
  labels (`container`, `stream`, `level`). `request_id` is deliberately *not* a label (one stream per request would
  exhaust Loki), so filter in the query: `{container="rcab-dev-api-1"} | json | request_id = "<id>"`.
  Loki and Alertmanager publish no host port: use Grafana (`:3001`) or reach them inside the network
  (`$DC exec -T api sh -c 'curl -s http://loki:3100/ready'`). Scene: [M03](../videos/ops/INDEX.md#m03).
- Error responses use a global `AppExceptionFilter` shape `{code, message, ...}`; the codes are catalogued in
  vault `40-backend/error-codes.md`.

## 3. Metrics and dashboards

- `curl -s localhost:3000/metrics` — Prometheus text. Business metrics worth knowing:
  `rcab_dispatch_outcome_total{outcome,kind}` (`assigned`, `no_driver`, `cancelled`, `scheduled_retry`,
  `scheduled_no_driver`, `pool_aborted`), `rcab_active_drivers`, `rcab_busy_drivers`, `rcab_outbox_pending`,
  `rcab_outbox_oldest_pending_age_seconds`, `rcab_outbox_exhausted`, ride transition counters, pool join/closure
  counters, dispatch latency histograms, HTTP latency with **route-template** labels (not raw ids).
  The sampled gauges are refreshed every 15 s (`METRICS_SAMPLE_INTERVAL_MS`) by `BusinessMetricsSampler`, and a gauge whose source cannot be
  read is *removed* rather than left stale: "missing series" means "telemetry failed", not "all quiet".
- Prometheus `:9090` (Status -> Targets to check scraping; scene [M02](../videos/ops/INDEX.md#m02)); Grafana `:3001`
  (`admin`/`admin`) with provisioned dashboards `overview`, `dispatch`, `logs`, `postgres`, `redis`
  (`infra/observability/grafana/dashboards/`; scene [M01](../videos/ops/INDEX.md#m01)); Uptime Kuma `:3003`
  (`pnpm setup:uptime-kuma` seeds monitors; [M04](../videos/ops/INDEX.md#m04)); Alertmanager is internal-only
  ([M05](../videos/ops/INDEX.md#m05)); alert rules are in `infra/observability/alert_rules.yml`.
- `pnpm obs:smoke` checks that Grafana/Prometheus/Uptime Kuma answer.

## 4. Redis and queues

`/redis-inspect` — one pass over every namespace with the real key names: driver presence
(`driver:state:<id>` hash with `availability`, `last_seen`, `session_id`, `current_ride_id`), the geo set
`active_drivers`, pool projections `pool:<id>`, OSRM polyline cache, BullMQ queues (`bull:dispatch:*`,
`bull:scheduled-dispatch:*`, `bull:matching:*`). Remember: **Redis is a projection**. When Redis and Postgres disagree,
Postgres is right and the reconciler (boot + periodic) repairs Redis. Idempotency and refresh-token revocation are
*not* in Redis.

`/pool-inspect` — shared pools: authoritative `shared_rides` + `pool_member` rows, the Redis `pool:<id>` projection
and its `state_version`, pending expiry timers, BullMQ depth. Use it during any shared-ride investigation.

Ad-hoc without a skill:

```bash
RC() { $DC exec -T redis redis-cli "$@"; }
RC HGETALL driver:state:<driverId>        # presence + current_ride_id
RC ZCARD active_drivers                   # online drivers
RC --scan --pattern 'bull:dispatch:*' | head
```

## 5. Postgres

- Port `55432` (not 5432). `$DC exec -T postgres psql -U rcab -d rcab`, or the project MCP `postgres` server.
- `/drizzle-studio` launches a visual browser (`cd apps/api && npx drizzle-kit studio`, UI at
  `https://local.drizzle.studio`); good for reading, avoid writing through it.
- Handy queries (state machines explained in [state-machines.md](../state-machines.md)):

```sql
-- who is busy, with what
SELECT * FROM driver_active_assignment;
-- live offers
SELECT id, trip_kind, driver_id, wave_number, state, expires_at FROM dispatch_offer WHERE state = 'offered';
-- outbox backlog / stuck intents
SELECT topic, aggregate_id, aggregate_generation, attempts, last_error, processed_at, failed_at
  FROM outbox WHERE processed_at IS NULL ORDER BY available_at LIMIT 20;
-- a ride's history of timestamps
SELECT status, dispatch_generation, accepted_at, en_route_at, arrived_at, started_at, completed_at, cancelled_by, cancel_reason
  FROM rides WHERE id = '<ride id>';
-- pool with members
SELECT pool_state, seat_count, max_seats, claimed_by_driver_id, state_version FROM shared_rides WHERE ride_id = '<id>';
SELECT passenger_id, active, agreed_fare_cents FROM pool_member WHERE pool_id = '<id>';
-- unresolved migration conflicts
SELECT * FROM migration_conflict WHERE resolved_at IS NULL;
-- applied migrations
SELECT name, ran_at FROM _rcab_migrations ORDER BY id;
```

## 6. Navigating the code: the code graph

`/code-graph <question>` answers structural questions from `codegraph/graph.json` instead of grepping:
`importers <file>`, `deps <Module>`, `route <METHOD /path>`, `tables`, `symbol <Name>`, `modules`, `regen`.
If `codegraph/.stale` exists (a hook drops it when code changes) regenerate first: `pnpm code:graph`.
`pnpm code:graph:check` reports drift between the vault's module notes and the code. `codegraph/graph.md` is the
human-readable form.

## 7. Realtime problems

Symptoms and where to look:

| Symptom | Likely cause | Check |
|---|---|---|
| Rider's tracking panel frozen after a reload | subscription not re-sent, or ride not yours | the socket re-sends `ride:subscribe` on every reconnect; the ack carries `ok:false, reason` (`forbidden`, `not_found`, `unavailable`); look at the api log for `ride:subscribe denied` |
| Driver never sees offers | not in `active_drivers`, vehicle missing/too small, already holds a live offer or assignment, OSRM down for pools | `/redis-inspect`; `eligibleCandidates` SQL in `offer.repository.ts`; `/pool-inspect` |
| Seeded drivers vanish after a minute | presence sweep (60 s) | `./scripts/seed-dev.sh --keepalive` |
| Offer shows then "unavailable" | accept refused: expired, taken, busy, capacity | `ride_offer_outcome.reason` in the driver app logs; reasons listed in [state-machines.md](../state-machines.md#5-dispatch-offer-dispatch_offerstate) |
| Ride stuck in `requested` | no outbox row published, no candidates, or worker not running | `outbox` query above; `rcab_outbox_pending`; api log for `no fresh candidates this wave`; `RCAB_DISABLE_*` env set by mistake |
| Events arrive out of order in a client | expected; clients gate on `version` and re-snapshot | `realtime.protocol.ts`, `ws.ts` version gate |

Quick socket test from the repo root (root devDependency `socket.io-client`): connect with
`io('http://localhost:3000', {auth:{token: '<access JWT>'}})` and emit `ride:subscribe {rideId}`.

## 8. Test-time debugging

- One failing spec: `pnpm --filter @rcab/api test -- path/to/file.spec.ts -t "name"`.
- For container lifecycle problems in integration runs, set `DEBUG=testcontainers*` and check that Docker is running.
- A hung unit run usually means a BullMQ worker or timer started: check `RCAB_DISABLE_*` seams
  ([testing.md](testing.md) section 3).
- Flutter: `flutter test --plain-name "…"`; add `--dart-define=ENABLE_API_LOGGING=true` when running the app to see
  Dio traffic.

## 9. Resetting a broken dev environment

| Problem | Fix |
|---|---|
| Redis state weird | `$DC exec -T redis redis-cli FLUSHALL` then restart the api; it rebuilds projections and timers from Postgres (this is the Redis-loss drill in miniature) |
| Fixture drivers gone | `./scripts/seed-dev.sh --reset --keepalive` |
| Schema behind | `$DC exec api npx tsx src/migrate.ts` |
| Everything | `pnpm dev:down -v` (**deletes volumes**, including the OSRM graph), then `pnpm dev:up` and migrate again |
| Stale code graph | `pnpm code:graph` |
