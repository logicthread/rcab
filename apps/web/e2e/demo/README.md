# Web demo recording harness (RCAB-E8.S14)

Re-records the passenger-app onboarding videos in `docs/onboarding/videos/web/` (scenes **W01-W10**) against the **running dev
stack**. Dev only. It is not part of `pnpm test:e2e` (different config, `testMatch`, and folder).

```bash
pnpm dev:up                       # api :3000, web :3002, postgres, redis, osrm
pnpm demo:record:web              # every scene, then rewrite videos/web/INDEX.md
pnpm demo:record:web -- W03 W07   # a subset (INDEX.md is rebuilt from scenes.json + the mp4s on disk)
node apps/web/e2e/demo/record.mjs --convert-only W08   # re-encode the last raw recording without re-running the browser
DEMO_SLOWMO=0 DEMO_TRACE=1 pnpm demo:record:web -- W05  # fast dry run with a timestamped step log
```

Prerequisites: ffmpeg (`/opt/homebrew/bin/ffmpeg`, override with `FFMPEG=`), Docker (the harness talks to Postgres and Redis with
`docker compose exec`), and Playwright's Chromium (`cd apps/web && npx playwright install chromium`). The harness never stops or
rebuilds the stack. Simulated drivers stay in **Guwahati Area A** (26.1445, 91.7362); the other recording harnesses use areas at least
2 x R2 (8 km) away (see `docs/POLICY.md`, dispatch R1/R2), so offers never leak between them.

## Files

| File | Purpose |
|---|---|
| `playwright.demo.config.ts` | Headless chromium, `slowMo` (default 200 ms, `DEMO_SLOWMO`), one worker, 5 min per scene |
| `record.mjs` | Runs the config, converts each raw `.webm` to H.264 MP4 (crf 28, retried at 31/34 if > 12 MB; W07 is `hstack`-ed), writes `scenes.json` + `INDEX.md` |
| `INDEX.header.md` | Intro text of the generated `INDEX.md` |
| `scenes/w0N-*.demo.ts` | One Playwright test per scene; each builds a `Scene`, narrates with `scene.step()`, ends with `scene.finish()` |
| `lib/scene.ts` | Recording context per scene (video on, 1280x720), session cookie injection, captions, metadata JSON for `record.mjs` |
| `lib/overlay.ts` | In-page caption bar with the state-machine chips, title card and a visible cursor (the ffmpeg build has no `drawtext`) |
| `lib/driver-sim.ts` | The scripted driver: online + heartbeat, offer policy (accept / decline / ignore), `driveTo`, state transitions, cancel, no-show, shared stop confirms |
| `lib/devstack.ts` | **Test-harness-only** dev-stack access: guards, `psql` / `redis-cli` via `docker compose exec`, access-token and refresh-token minting, wake-job promotion |
| `lib/fixtures.ts` | Fixture riders and drivers (`firebase_uid LIKE 'webrec-%'`, ids `...0074NN` / `...0075NN` / `...0076NN`) and their cleanup |
| `lib/booking-ui.ts`, `lib/map.ts` | Booking-page helpers: tap a lat/lng on the Leaflet map, wait for the quote, choose Private / Share |

## Sessions (how the scenes get past sign-in)

Both apps sign in with a real Firebase phone OTP, which a recording must not trigger. W02 therefore shows the sign-in **UI only**.
For W03-W10 the harness creates a session for a fixture rider the way `infra/load/prepare-dev.mjs` does for load users:

1. `lib/devstack.ts` refuses to run against a non-loopback API, `NODE_ENV=production`, a missing `.env.dev`, or a compose project that
   is not `dev`/`test`.
2. `createRefreshToken(userId)` inserts a **hashed** row into `auth_refresh_token` (same shape `AuthService.issueSession` writes).
3. The raw token is put in the browser's HttpOnly `refresh_token` cookie; the web app then signs in through its normal silent-refresh
   path (`POST /v1/auth/refresh`).
4. The simulated driver uses an ordinary HS256 access token signed with the dev `JWT_SECRET` (`mintAccessToken`).

There is no backdoor endpoint or code path in the shipped web app or API.

## Harness shortcuts (called out in each scene's note in INDEX.md)

- **No-show (W05):** the driver may report a no-show only 5 min after `arrived` (`rides.noShowWaitMs`). The harness back-dates
  `rides.arrived_at` by 6 min in the dev DB instead of recording a 5-minute wait.
- **Scheduled wake (W08):** the wake job is due 10 min before pickup and the earliest pickup is 15 min out. The harness promotes the
  delayed BullMQ job (`promoteScheduledWake`) so the real wake worker runs now.
- **No driver (W06):** recorded at the shipped dispatch windows (wave 2 at +30 s, hard fail at +60 s); the wait is real time, no env
  overrides, the api is not restarted.
- **Shared pool (W07):** recorded at the shipped `matching.poolTimeoutMs` (60 s) and `matching.maxSeats` (3). Two riders leave the
  pool `open` at 2 of 3 seats, so it closes by timeout (`closed_timeout`) after the real 60 s wait; a third rider would close it as
  `closed_full`. No env override, the api is not restarted. The two recorded 640x720 contexts are composed with `ffmpeg hstack`.
- **Reload / reconnect (W09):** the connection loss is Playwright's `page.routeWebSocket`: a handler registered before the page loads
  passes every socket.io WebSocket through, and while the scene sets `blocked = true` it closes the live sockets and every reconnect
  attempt immediately; flipping it back lets socket.io-client reconnect by itself and re-subscribe (`ride:snapshot`).
- **Driver heartbeat after accept:** the first location packet after an accept makes the server start `en_route` implicitly, so the
  simulator pauses its heartbeat after an accepted offer (`DriverSim.holdAfterAccept`) until the scene calls `driveTo`; otherwise the
  "Driver assigned" (`accepted`) state would flash by in under 2.5 s.
- **Fixture hygiene:** rides are cancelled with SQL between scenes, so `ensureClient` / `releaseClient` also free the driver assignment
  guard (`driver_active_assignment`) and pool rows; otherwise a simulated driver stays "busy" with a cancelled ride and gets no offers.
- **DB calls are bounded:** each `docker compose exec` has a 40 s timeout and 3 attempts, because a stalled call freezes Playwright's
  timers (the calls are synchronous).

## Adding or changing a scene

1. Copy a scene file, give it a new `id`/`slug`, list the state `chips` it will show, and call `scene.step(page, text, state?)` as the
   story advances (passing `state` lights up that chip).
2. Keep drivers in Area A, use a free fixture number (`ensureClient(n)` / `ensureDriver(n)`), release them in `finally`.
3. Keep each video 15-150 s; check with `DEMO_SLOWMO=0 DEMO_TRACE=1` first.
4. `pnpm demo:record:web -- Wxx`, then look at a few frames (`ffmpeg -ss 20 -i file.mp4 -frames:v 1 f.png`) before committing.

`out/` (raw webm, Playwright results) is git-ignored; the MP4s and `scenes.json` under `docs/onboarding/videos/web/` are committed.
