# rcab — Run & Demo Guide (authoritative, 2026-07-17)

> How to bring up every service by hand and walk every demo (0→5) end to end.
> Code-verified; supersedes the port/table details in the older
> `demo-walkthrough.md`. Read `docs/ARCHITECTURE.md` first for the why.

## 0. Prerequisites & honest caveats (read once)

- **Docker Desktop running**, pnpm 10 (Node ≥20), and (for the driver app) Flutter +
  an Android emulator/device.
- **Correct host ports:** API `3000`, **web `3002`**, Redis `6379`, **Postgres `55432`**
  (container 5432; host 5432 is usually a locally-installed Postgres). With the `obs`
  profile: **Grafana `3001`**, Prometheus `9090`, Uptime-Kuma `3003`.
- **⚠ OSRM, Loki and Alertmanager publish NO host port** in `docker-compose.dev.yml` — they
  live only on `rcab_dev_net`. Reach them with `docker compose … exec` (OSRM via
  `curl http://osrm:5000` from the api container). `localhost:5000` / `localhost:3100` refuse.
- **⚠ Driver presence expires.** The api auto-offline sweep runs every 15 s and drops any
  driver whose `driver:state:<id>.last_seen` is older than 60 s. A seeded driver that never
  heartbeats disappears from `active_drivers` about a minute later — use
  `./scripts/seed-dev.sh --keepalive` while you need them online.
- **Postgres creds:** `rcab / rcab`, db `rcab`.
- **OSRM dev graph = NE-India (Guwahati)**, ~`(26.1445, 91.7362)`. All test pickup/drop
  coordinates must be in that region or OSRM returns no route.
- **Seeding:** `./scripts/seed-dev.sh [--reset] [--drivers N] [--offline] [--keepalive]` (or `/seed-db`)
  upserts fixture drivers/clients/vehicles and puts the drivers in the Redis geo index
  around Guwahati. Caveat: seeded users have synthetic `firebase_uid`s, so they **cannot
  sign in via OTP**, and they never answer an offer — accepting still needs a real driver
  on the Flutter app. `test-fixtures` `seedPilotCity` remains an empty stub.
- **⚠ Migrations are not auto-applied** on `dev:up`/restart. Apply them explicitly (§1.3). Latest is `0017_pool_member_agreed_fare`; **apply all pending ones** (the runner skips what is already applied) before testing sign-in or booking.
- **Dev runner:** the api dev container runs `node --watch` with an SWC loader (emits decorator metadata), not `tsx watch`. Dev defaults apply only when `NODE_ENV=development`; any other value requires a strong `JWT_SECRET` (>=32 bytes) and `CORS_ORIGINS` or the api refuses to start.
- **Firebase phone auth:** the web/driver sign-in uses real Firebase phone OTP. For
  testing without SMS, add **test phone numbers with fixed codes in the Firebase console**
  (Authentication → Sign-in method → Phone → Test numbers). `FIREBASE_PHONE_TEST_TOKEN`
  in `.env.dev` is a pre-minted ID token for curl-only client checks (§3, Demo 1-alt).

---

## 1. Bring up every service

### 1.1 Start the full stack (incl. observability)
```bash
pnpm dev:up          # docker compose up -d --build, auto-creates .env.dev, incl. obs profile
pnpm dev:smoke       # polls api / until pg+redis connected → 200
```
First run builds the OSRM graph (`osrm-prep`/`osrm-extract`) — can take a few minutes.

### 1.2 Verify each service
```bash
curl -s localhost:3000/v1/health/live  | jq          # {"ok":true}
curl -s localhost:3000/v1/health/ready | jq          # postgres/redis/osrm all ok
curl -s localhost:3000/metrics | head                # prometheus text
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T api \
  sh -c 'curl -s "http://osrm:5000/route/v1/driving/91.7362,26.1445;91.7898,26.1758"' | jq .code   # "Ok"
open http://localhost:3002        # web app
open http://localhost:3001        # Grafana (admin/admin)
open http://localhost:3003        # Uptime-Kuma
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml ps   # all healthy
```
Or one shot: `/smoke-check`.

### 1.3 Apply migrations (once per fresh DB)
```bash
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts
# expect: [migrator] applied 00xx_*.sql … [migrator] done
```
Confirm the scheduled columns exist:
```bash
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T postgres \
  psql -U rcab -d rcab -c "\d rides" | grep -E 'type|scheduled_for'
```

### 1.4 Driver app (Flutter, outside compose)
```bash
cd apps/driver-app
flutter pub get
flutter run           # on a device/emulator; point its API config at the laptop LAN IP, not localhost
```
(For tests instead of a live device: `/flutter-test [unit|widget|integration]`.)

### 1.5 Tear down
```bash
pnpm dev:down         # stops + removes (incl. obs). add -v to wipe volumes for a clean slate
```

---

## 2. Demo 0 — "Hello, stack" (E1)

**Proves:** every container comes up, health is reachable, tests pass.

1. `pnpm dev:up && pnpm dev:smoke` → green for every service.
2. The four curls in §1.2 all succeed (`ok`, readiness ok, metrics, OSRM `Ok`).
3. Grafana (`:3001`) renders a panel; Uptime-Kuma (`:3003`) monitor is green.
4. `pnpm test` and `pnpm test:int` both exit 0. Or the full gate: `pnpm verify`.

**Pass:** all of the above green. **Common miss:** OSRM `code != Ok` → graph still
extracting (`docker compose … logs osrm-extract`); stale pg volume → `pnpm dev:down -v`.

---

## 3. Demo 1 — "I am a real user" (E2, web auth)

**Proves:** phone-OTP signup, JWT issue, refresh, logout.

1. Open `http://localhost:3002/signin`.
2. Enter a **Firebase test phone number** (configured in the Firebase console), solve the
   invisible reCAPTCHA, **Send OTP**.
3. Enter the fixed test code → **Verify** → you land on `/book` as a signed-in client.
4. DevTools → Application → Cookies → confirm `refresh_token` is `HttpOnly`, `SameSite=Lax`, path `/v1/auth`.
5. Inspect the user row:
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T postgres \
     psql -U rcab -d rcab -c "SELECT id, phone_e164, role FROM app_user ORDER BY created_at DESC LIMIT 5;"
   ```
6. Hard-refresh → still signed in (refresh flow). **Sign out** → cookie cleared; a stale
   access token now returns 401.

**Demo 1-alt (curl only, no browser):** if `.env.dev` has a valid `FIREBASE_PHONE_TEST_TOKEN`:
```bash
curl -s localhost:3000/v1/auth/firebase-exchange -H 'Content-Type: application/json' \
  -d "{\"id_token\":\"$FIREBASE_PHONE_TEST_TOKEN\"}" | jq   # → {access_token, user}
```
Use that `access_token` as `Authorization: Bearer …` for the API-only checks below.

**Pass:** one `app_user` row per phone (no dup on re-signin); logout revokes the JWT.

---

## 4. Demo 2 — "The driver is online" (E3, driver app)

**Proves:** driver signs in, registers a vehicle, goes online, streams location → Redis geo.

1. Launch the driver app (§1.4). Sign in with a **driver** test phone number.
2. Register a vehicle (type, reg no, seats) → `POST /v1/vehicles`.
3. Toggle **Online** → `POST /v1/drivers/online` (foreground service notification appears).
4. The app streams `driver:location` over WS. Verify presence:
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T redis \
     redis-cli ZRANGE active_drivers 0 -1 WITHSCORES
   docker compose … exec -T redis redis-cli HGETALL driver:state:<driver-user-id>
   ```
   Or `/redis-inspect`. Move the emulator GPS → scores update at ~1 Hz (3 s geo throttle).
5. Toggle **Offline** → the driver drops out of `active_drivers`.

**Pass:** driver appears in `active_drivers` while online, gone when offline; `driver:state`
hash reflects availability. **Common miss:** emulator GPS outside the Guwahati graph area.

---

## 5. Demo 3 — "Book a normal ride" (E4, web + driver)

**Proves:** quote → request → dispatch → accept → drive → complete → rate.

**Setup:** a client signed in on web (Demo 1) **and** a driver online near the pickup
(Demo 2), both within the Guwahati graph. (No driver app? See §7 to fake presence, but
completing the *accept* needs a real authed driver — the app.)

1. **Web** (`/book`): pick pickup + drop on the Leaflet map (Guwahati area). A live quote
   shows fare + ETA (`POST /v1/rides/quote`).
2. Click **Book** → `POST /v1/rides` (type=normal, Idempotency-Key). Ride persists
   `requested` → dispatch fans out.
3. **Driver app** shows a ringing **offer** card (`ride_offer`) with a countdown →
   **Accept** (`ride_offer_response{accept:true}`). Ride → `accepted`; the web flips to a
   live-tracking view.
4. Driver drives the state machine (`POST /v1/rides/:id/state`): en_route → arrived →
   start → complete. Web shows the driver marker moving (`driver_location`, 1 Hz) and the
   status banner updating (`ride_state_changed`).
5. On `completed`, both sides get a **rating** prompt → submit stars (`POST /v1/rides/:id/ratings`).

Inspect while it runs:
```bash
docker compose … exec -T postgres psql -U rcab -d rcab -c \
  "SELECT id,status,type,driver_id,fare_cents FROM rides ORDER BY created_at DESC LIMIT 3;"
/redis-inspect   # presence, pool projections, BullMQ (offers/claims now in Postgres)
```

**Pass:** exactly one driver wins; ride reaches `completed`; a `ratings` row per direction.
**No-driver path:** with nobody online, dispatch exhausts wave-2 → `no_driver` + client
notified.

---

## 6. Demo 4 — "Shared works" (E5)

**Proves:** two clients on overlapping corridors pool into one shared ride.

**Setup:** ≥2 clients + ≥1 driver online, routes that overlap in Guwahati.

1. Client A books with **Share** selected (`POST /v1/rides` type=shared) → opens a pool.
2. Client B books a **similar** route (overlapping corridor) → matching scores it against
   A's open pool and **slots** B in (`pool:update` fans out; seat count ticks). Inspect:
   ```bash
   /pool-inspect      # open pools, seat counts, expiry timers, BullMQ depth
   ```
3. Pool closes (seats full or timeout) → shared dispatch offers the driver the **multi-stop
   sequence** (`/v1/rides/:id/stops`).
4. Driver confirms stops in order (`stop:pickup_confirmed` / `stop:drop_confirmed`) — the UI
   won't allow a drop before its pickup.
5. Per-seat pricing: each passenger's shared fare < their solo fare (the discount applied).

**Pass:** both clients share one ride; seat count never exceeds `max_seats`; stops complete
in order; per-seat < solo.

---

## 7. Demo 5 — "Scheduled works" (E6)

**Proves:** book now for a future time; the system wakes ~10 min before pickup and
dispatches like a normal ride; cancel is free before wake.

1. **Quote** a scheduled ride (same as normal — `POST /v1/rides/quote`, type=scheduled).
2. **Request** with a `scheduledFor` 15 min–24 h out:
   ```bash
   curl -s localhost:3000/v1/rides -X POST -H "Authorization: Bearer $ACCESS" \
     -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
     -d '{"type":"scheduled","originLat":26.1445,"originLng":91.7362,"destLat":26.1758,"destLng":91.7898,"quoteToken":"<from quote>","scheduledFor":"<ISO 20min from now>"}' | jq
   ```
   → ride persists `requested` type=scheduled; **no dispatch yet**. A delayed job is queued:
   ```bash
   docker compose … exec -T redis redis-cli KEYS 'bull:scheduled-dispatch:*'
   ```
3. **Wake:** when `scheduledFor − 10 min` arrives, the job fires → `DispatchStartService.wakeScheduled`
   starts normal dispatch (identical to Demo 3, with a 4-minute accept window and automatic retry). To demo fast, set `scheduledFor` ~16 min out
   (wake in ~6 min) or override `SCHEDULED_WAKE_LEAD_MS` low in `.env.dev` and restart api.
4. **Cancel before wake** (`POST /v1/rides/:id/cancel`) → ride `cancelled` **and** the
   delayed job is dropped (free). After wake, normal cancel rules apply.

**Pass:** scheduled ride doesn't dispatch until wake; wake runs the normal path to
completion; pre-wake cancel removes the job (verify the `bull:scheduled-dispatch:*` key is gone).

**Out-of-window guard:** `scheduledFor` < 15 min or > 24 h → 400 `scheduled_for_out_of_window`.

---

## 8. Manual data setup (since seeding is a stub)

To place a driver in the geo index for inspection (note: completing an *accept* still needs
a real authed driver app — this is for seeing dispatch fan-out and presence):
```bash
# a driver user + vehicle, online (psql)
docker compose … exec -T postgres psql -U rcab -d rcab <<'SQL'
INSERT INTO app_user (id, firebase_uid, phone_e164, role, status)
  VALUES (gen_random_uuid(), 'fb-demo-drv', '+919990000002', 'driver', 'active')
  RETURNING id;   -- note the id → :DID
SQL
# then (substitute :DID):
#   INSERT INTO vehicle (id, driver_id, type, reg_no, seats, active) VALUES (gen_random_uuid(), ':DID', 'cab_sedan', 'AS-01-DEMO-1', 4, true);
#   INSERT INTO driver (user_id, availability, current_vehicle_id) VALUES (':DID', 'online', '<vehicle id>');

# place them in the geo index near Guwahati
docker compose … exec -T redis redis-cli GEOADD active_drivers 91.7362 26.1445 ':DID'
docker compose … exec -T redis redis-cli HSET driver:state:':DID' availability online
```

## 9. Inspection cheat-sheet

```bash
/smoke-check          # per-service health table
/redis-inspect        # driver geo, BullMQ queues, pool projections (refresh-token revocation is in Postgres)
/pool-inspect         # shared-ride pools (E5+)
/osrm-check           # routing graph loaded + a test route
/code-graph deps RidesModule        # what a module depends on (no source grep)
/code-graph route "POST /v1/rides"  # where a route is defined
# live ride rows:
docker compose … exec -T postgres psql -U rcab -d rcab -c \
  "SELECT id,status,type,scheduled_for,driver_id FROM rides ORDER BY created_at DESC LIMIT 5;"
```

## 10. Known gaps (not bugs — future epics)
- No automated seed (stub) · no ratings aggregation/history (E7) · no earnings data (E7)
- Alerting not wired / backup restore not drilled (E8) · no prod VPS deploy validated (E8/E9)
