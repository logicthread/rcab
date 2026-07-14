# rcab — Demo Walkthrough & Human Testing Guide

This guide walks through every demo that is **built and shippable** today (Demos 0–4 — epics E1–E5). It is the first human-facing testing pass for the project; until now everything has been gated by automated tests only.

For each demo you get:

1. **What it proves** — the headline.
2. **Pre-flight** — what must be true before you start.
3. **Step-by-step** — copy-pasteable.
4. **Pass criteria** — exact things to look for.
5. **Common failures** — what red looks like, and where to look.

Companion: [`technical-guide.md`](./technical-guide.md) explains the architecture and the endpoints/modules each demo exercises.

---

## Test environment

Single laptop. No remote services needed except Firebase Auth (phone OTP).

| Service | URL | Purpose |
|---|---|---|
| API | http://localhost:3000 | NestJS backend |
| Web | http://localhost:3002 | Next.js client app |
| Grafana | http://localhost:3001 | Dashboards (admin/admin) |
| Prometheus | http://localhost:9090 | Raw metrics |
| Uptime Kuma | http://localhost:3003 | Synthetic monitor |
| Postgres | localhost:5432 | `postgres` / `postgres` (dev) |
| Redis | localhost:6379 | No password (dev) |
| OSRM | container-internal only (`osrm:5000`) | Route engine — probe via `docker exec rcab-dev-api-1 node -e "fetch('http://osrm:5000/route/v1/driving/77.59,12.97;77.61,12.95').then(r=>r.text()).then(console.log)"` |

**Driver app** runs on a connected Android device or emulator pointed at the laptop's LAN IP (not `localhost` — the Android emulator's `localhost` is itself).

### One-time setup

```bash
# Workspace bring-up
pnpm install
pnpm build

# Stack
pnpm dev:up          # builds + starts every container; first run takes ~5 min (OSRM extract)
pnpm dev:smoke       # waits for /v1/health/ready=200 across the stack

# Driver app
cd apps/driver-app
flutter pub get
flutter run -d <device-id>   # set API_BASE_URL via --dart-define=API_BASE_URL=http://<LAN-IP>:3000
```

If `dev:smoke` fails: `pnpm dev:logs` and look for the red service. Most common: Firebase service-account env var missing (Demo 1+).

### Test-data shortcuts

```bash
# Reset DB and seed default fixtures (2 drivers, 2 clients, vehicles)
pnpm --filter=api tsx scripts/seed/seed.ts --reset --scenario=default

# Shared-ride scenario (drivers + clients on overlapping routes)
pnpm --filter=api tsx scripts/seed/seed.ts --reset --scenario=shared-ride
```

Or via skill: `/seed-db --reset --scenario=default`.

### Inspection cheatsheet

| Need to see… | How |
|---|---|
| Driver geo presence | `/redis-inspect` or `redis-cli ZRANGE drivers:geo 0 -1 WITHSCORES` |
| Active shared-ride pools | `/pool-inspect` |
| BullMQ queues (dispatch, offers) | `/redis-inspect` |
| Database rows | `/drizzle-studio` (opens browser at :4983) |
| Container CPU/mem | `/docker-stats` |
| API latency per endpoint | Grafana → "API latency" dashboard |
| Container logs | `pnpm dev:logs` (all) or `docker logs -f rcab_api_dev` |

---

## Demo 0 — Hello, stack (epic E1)

**Proves:** docker-compose brings up every container; health is reachable; CI passes.

### Pre-flight
- Fresh checkout (or `pnpm dev:down -v` to wipe volumes).
- `.env.dev` exists (auto-created by `dev:up` if missing).

### Steps
1. `pnpm dev:up`
2. Wait for output to settle. Run `pnpm dev:smoke`.
3. Hit each health endpoint manually:
   ```bash
   curl -s localhost:3000/v1/health/live  | jq
   curl -s localhost:3000/v1/health/ready | jq
   curl -s localhost:3000/metrics         | head -20
   curl -s localhost:5000/route/v1/driving/77.59,12.97;77.61,12.95 | jq '.code'
   ```
4. Open Grafana (http://localhost:3002, admin/admin). Confirm at least one panel renders with data.
5. Open Uptime Kuma (http://localhost:3003). Confirm the API monitor is green.
6. `pnpm test` — unit tests across the workspace.
7. `pnpm test:int` — integration tests against real Postgres/Redis (Testcontainers spins up its own).

### Pass criteria
- `dev:smoke` returns green for **every** service it polls.
- `/v1/health/ready` returns `{"status":"ok","postgres":"ok","redis":"ok"}`.
- OSRM responds `{"code":"Ok"}` to the curl above.
- Grafana shows live data within ~30 s.
- `pnpm test` and `pnpm test:int` both exit 0.

### Common failures
- **OSRM `code` is not `Ok`** → graph still extracting. Wait, or `docker logs rcab_osrm_prep_dev`.
- **Postgres "role not found"** → stale volume; `pnpm dev:down -v && pnpm dev:up`.
- **CI red but local green** → `corepack enable` mismatch or Node version. Use `nvm use 20`.

---

## Demo 1 — I am a real user (epic E2)

**Proves:** end-to-end phone-OTP signup in the web app; refresh tokens; logout.

### Pre-flight
- Demo 0 passed.
- Firebase project configured: `FIREBASE_SERVICE_ACCOUNT_JSON` in `.env.dev` and matching web client config in `apps/web/.env.local` (`NEXT_PUBLIC_FIREBASE_*`).
- A real phone you can receive SMS on (Firebase free tier permits low volume).

### Steps
1. Open http://localhost:3001 → click **Sign in**.
2. Enter phone number with country code (e.g. `+91XXXXXXXXXX`).
3. Solve the reCAPTCHA, click **Send OTP**.
4. Enter the 6-digit OTP from SMS, click **Verify**.
5. Confirm you land back on `/` as a signed-in user (name/phone visible in header).
6. Open DevTools → Application → Cookies. Confirm `rcab_refresh` cookie set, `HttpOnly`, `SameSite=Strict`.
7. In a new terminal:
   ```bash
   # Find your user row
   psql postgres://postgres:postgres@localhost:5432/rcab -c \
     "SELECT id, phone, created_at FROM users ORDER BY created_at DESC LIMIT 5;"
   ```
8. Hard-refresh the page. You should stay signed in (refresh-token flow kicked).
9. Click **Sign out**. Confirm cookie cleared and you're back at the public page.
10. Try to use the old access token in DevTools:
    ```bash
    curl -H "Authorization: Bearer <expired-token>" localhost:3000/v1/rides/quote -d '{}' -H "Content-Type: application/json"
    ```
    → expect `401 Unauthorized` (token revoked on logout).

### Pass criteria
- OTP arrives within 30 s.
- User row in `users` table after first sign-in; **not** duplicated on subsequent sign-ins.
- Refresh cookie is `HttpOnly` + `SameSite=Strict` + `Secure` (in prod build).
- Sign-out revokes the JWT (next API call with the stale access token → 401).

### Common failures
- **`auth/captcha-check-failed`** → reCAPTCHA site key in `NEXT_PUBLIC_FIREBASE_*` doesn't match Firebase console.
- **OTP never arrives** → check Firebase Auth → Sign-in method → Phone is enabled, and the test number isn't in the whitelist.
- **`401` on first call after OTP** → API can't reach Firebase Admin; check `FIREBASE_SERVICE_ACCOUNT_JSON` is valid one-line JSON.

---

## Demo 2 — The driver is online (epic E3)

**Proves:** driver app phone-OTP, vehicle registration, online toggle, location stream to Redis.

### Pre-flight
- Demos 0–1 pass.
- Android device or emulator with location enabled and on the same network as the laptop.
- Find laptop LAN IP: `ipconfig getifaddr en0` (macOS).
- `flutter run --dart-define=API_BASE_URL=http://<LAN-IP>:3000` from `apps/driver-app/`.

### Steps
1. Driver app launches → **Sign in** screen.
2. Phone-OTP (same Firebase project as web).
3. After OTP, app routes to **Vehicle registration**:
   - Enter plate, make, model, color, seats.
   - Submit.
4. Lands on **Home** with **Offline / Online** toggle.
5. Flip to **Online**. Grant location permission when prompted; foreground service notification appears in the system tray.
6. On laptop:
   ```bash
   /redis-inspect
   # or:
   redis-cli ZRANGE drivers:geo 0 -1 WITHSCORES
   redis-cli HGETALL driver:<driverId>:presence
   ```
   Expect your driver in the geo index with recent timestamp.
7. Walk around / drag emulator pin. Re-run the redis check — coords update at ~1 Hz.
8. Toggle **Offline**. Within 5 s the driver disappears from `drivers:geo`.

### Pass criteria
- Driver row in `drivers` table after OTP.
- Vehicle row linked to driver in `vehicles` table.
- `drivers:geo` ZSET contains the driver while online, removed while offline.
- Foreground service survives the screen turning off for at least 2 minutes (re-check redis).

### Common failures
- **Driver app can't reach API** → wrong LAN IP, or firewall blocks port 3000. Test with `curl http://<LAN-IP>:3000/v1/health/live` from another device.
- **No location updates** → location permission denied, or device location services off.
- **Driver vanishes when screen locks** → OEM kill (Xiaomi, OnePlus). Open the OEM-kill onboarding modal — it explains the per-OEM whitelist.

---

## Demo 3 — Book a normal ride (epic E4)

**Proves:** quote → request → dispatch → driver accept → ride lifecycle → completion → two-sided rating.

### Pre-flight
- Demos 0–2 pass.
- One **client** signed in on web; one **driver** online in driver app, geo-located somewhere near your test pickup.
- Easier: `/seed-db --reset --scenario=default` seeds 2 drivers around `(12.97, 77.59)` (Bangalore). Have the driver app's emulator GPS point to that area.

### Steps — client side (web)
1. Open http://localhost:3001/book.
2. Pick a **pickup** point on the OSM map (click).
3. Pick a **drop** point.
4. The form shows ETA + fare quote within ~2 s (OSRM round-trip).
5. Click **Request ride**.
6. UI flips to "Searching for drivers…" with a spinner.

### Steps — driver side
7. Driver app **offer screen** pops up (push notification + WS event).
8. Card shows: pickup address, drop address, distance, expected fare, expiry countdown (default 12 s).
9. Tap **Accept**. (You have a 2nd wave fallback — see Common failures.)

### Steps — client side again
10. UI transitions to "Driver assigned": driver name/plate/photo + live position on the map.
11. Watch the driver position update at ~1 Hz.

### Steps — ride lifecycle (driver)
12. Driver taps **Start trip** → state `en_route`.
13. Driver taps **Arrived at pickup** → state `arrived`.
14. Driver taps **Begin ride** → state `in_progress`.
15. Driver taps **Complete** → state `completed`.

### Steps — rating
16. Client web modal: "Rate your driver" (1–5 stars + optional comment). Submit.
17. Driver app rating screen: "Rate your passenger". Submit.

### Pass criteria
- Quote returns ≤ 2 s and matches expected ballpark (₹ depending on distance per `pricing` module).
- Ride row in `rides` table; state transitions in order with timestamps in `ride_events` (or equivalent — check schema).
- Driver location stream visible on client map throughout.
- After completion: two rows in `ratings` (one per side); driver's `drivers.rating_count` increments (aggregation lands in E7; for E4 just confirm the row inserted).
- Cancellation path: re-run, click **Cancel** in the client UI mid-search → ride row marked `cancelled`, driver app dismisses offer.
- No-show path: as driver, accept then sit at `arrived` past the no-show timer → ride auto-cancels.

### Common failures
- **No drivers offered** → driver not in geo index, or further than the candidate radius. Check `/redis-inspect`. Move the emulator GPS closer.
- **Offer expires before driver taps Accept** → wave-2 kicks in to the next-closest driver. If both waves fail you get "no drivers available" — increase candidate count temporarily in `dispatch.config.ts`.
- **Driver position not updating on client map** → check WS subscription. DevTools → Network → WS → look for `ride:subscribe` ack and inbound `driver:location` frames.
- **Rating modal doesn't appear** → check `ride.completed_at` is set and the ride owner matches the signed-in user.

---

## Demo 4 — Shared works (epic E5)

**Proves:** two requests with overlapping routes pool into one ride; driver sees both pickups + drops; pricing splits per seat.

### Pre-flight
- Demos 0–3 pass.
- **One driver online** in geo index.
- **Two clients** signed in on two browsers (Chrome + an Incognito window works).
- Use `/seed-db --reset --scenario=shared-ride` which sets up routes designed to overlap.

### Steps
1. Two clients open `/book`.
2. **Both** toggle the **"Share my ride"** option (default ON post-E5.S6).
3. Client A picks a pickup near `A_start` and drop near `A_end`.
4. Client A clicks **Request**.
5. Within ~30 s (pool open window), Client B picks a similar pickup near `B_start` and drop near `B_end` (configured in the seed scenario to score >0.7 similarity).
6. Client B clicks **Request**.
7. Both clients show "Pool growing… 2/2 seats filled" (or similar status — check `apps/web/src/app/book/page.tsx` for exact copy).
8. Once pool closes (size hit or timer expired), driver app gets **one** offer with **two stops shown in order**.
9. Driver accepts.
10. Driver app **shared-ride screen** shows the route with both pickups + both drops in sequence.
11. Driver completes stops one-by-one:
    - Pickup A → tap "Picked up A" (emits `stop:pickup_confirmed`).
    - Pickup B → tap "Picked up B".
    - Drop A → tap "Dropped A" (`stop:drop_confirmed`).
    - Drop B → tap "Dropped B".
12. Each client UI updates as their own stops happen.
13. After both drops → completion → rating prompts both clients independently.

### Pass criteria
- One **ride** row, two **ride_passengers** (or equivalent) rows.
- Per-seat fares sum to less than two solo fares (confirms shared-ride pricing applied — see `pricing` module).
- Stops are visited in optimized order (not strictly request order).
- Each client receives only their own stop events (privacy).
- Pool inspection during step 7: `/pool-inspect` shows the open pool with both passengers.

### Common failures
- **Second request opens a new pool instead of joining** → route similarity score too low. Inspect `/pool-inspect` after step 4 to see the pool's accepted-similarity threshold; verify Client B's route geometry overlaps.
- **Pool closes before B requests** → pool open window is short. Reduce `POOL_OPEN_TTL_MS` in env or request faster.
- **Driver app crashes on multi-stop screen** → likely null safety in `shared_ride_screen.dart`; capture `flutter logs` and file.

---

## Cross-cutting things to test (every demo)

Run these once you've walked all four demos:

1. **Restart resilience.** Stop API only (`docker compose ... stop api`), confirm web shows reconnection state, restart, confirm WS reconnects.
2. **Token expiry.** Set `JWT_ACCESS_TTL=60s` in env, sit on a page for >60 s, take an action → expect transparent refresh-token roll, no re-login.
3. **Multi-tab.** Sign in on tab A, sign out on tab B → tab A's next action 401s and redirects to sign-in.
4. **Slow network.** Chrome DevTools → throttle to "Slow 3G". Quote should still return (just slower); driver position should still update (just laggier).
5. **Container kill.** `docker kill rcab_redis_dev` mid-ride. Observe how the system fails — this is your unhappy-path documentation. Then `docker compose ... start redis` and confirm recovery.
6. **Observability.** During each demo, glance at Grafana. Note any panel that stays empty — those are the gaps E8 needs to fill.

---

## Reporting findings

Keep a running log in `docs/manual-testing/findings-YYYY-MM-DD.md` with sections per demo:

```
## Demo 3 — Book a normal ride
- [bug] On 4th request, driver gets two simultaneous offers. Repro: …
- [polish] Map pin drift on iOS Safari.
- [missing] No toast when ride is auto-cancelled (no-show).
```

Anything bug-shaped → file a GitHub issue with the `manual-test` label and link from the findings doc.

Anything missing-feature shaped → don't file yet. Match against the E8 production-hardening backlog and E7 dashboards before opening new scope.

---

## What is NOT testable yet

- **Demo 5 — Scheduled bookings.** E6 not started.
- **Demo 6 — Aggregated ratings + history pages + earnings.** E7 not started (ratings *insert*, but aggregation/UI don't exist).
- **Demo 7 — Production hardening.** E8 not started. Alerting, backups, security sweep, load test all pending.
- **Demo 8 — Pilot.** E9 not started.

See [`technical-guide.md`](./technical-guide.md) for the full module map and what each module covers.
