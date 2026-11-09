# Workflow: local setup

Goal: from a fresh clone to a running stack, a signed-in web app, and (optionally) the driver app on an Android
emulator. Authoritative long form: [`docs/manual-testing/RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md) section 1.
Videos of the finished result: [web scenes](../videos/web/INDEX.md), [driver scenes](../videos/driver-app/INDEX.md),
[ops scenes](../videos/ops/INDEX.md).

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop (or engine + compose v2) | recent | Must be running. Integration tests also use it (Testcontainers). |
| Node.js | >= 20 (the repo was last run on 22) | Managed with fnm on the maintainer machine. |
| pnpm | 10 (`packageManager: pnpm@10.33.4`) | Enable with `corepack enable` **only after** reading the hard stop below. |
| Flutter | 3.22+ | Only for `apps/driver-app` (outside the pnpm workspace). |
| Android Studio / SDK + an emulator | any recent API level | Driver app target. |
| k6 | recent | Only for load tests. |

**Hard stop (HITL):** installing a system-level package (brew/apt) or switching corepack versions needs the
owner's approval when you are working with Claude Code (see [story-lifecycle.md](story-lifecycle.md)).

**PATH gotcha.** On the maintainer's machine `pnpm`/`node` exist only in interactive shells (fnm multishell via
`~/.zshrc`). Non-interactive shells — Claude Code's Bash tool, cron, CI wrappers — fail with `command not found: pnpm`.
Prefix them:

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"   # node 22 + pnpm 10.33.4
```

Other host-port surprises: host `5432` is usually a *locally installed* Postgres (so the project maps Postgres to
`55432`), and host `5000` is macOS AirPlay (so OSRM is deliberately not published).

## 2. Clone, install, start

```bash
pnpm install                 # workspace: apps/api, apps/web, packages/*  (driver-app is NOT in it)
pnpm dev:up                  # bash scripts/dev-up.sh  -> docker compose up -d --build, WITH the obs profile
pnpm dev:smoke               # polls api / until postgres + redis are connected -> 200
```

`dev:up` copies `.env.dev.example` to `.env.dev` on first run. Variables you may need to edit there:
`POSTGRES_*`, `OSM_PBF_URL` (OSRM map extract), `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`,
`FIREBASE_PHONE_TEST_TOKEN` (pre-minted ID token for curl-only checks), `JWT_SECRET`, `NEXT_PUBLIC_API_URL`.
Secrets handling is a HITL area (`80-infrastructure/secrets-management.md`): never commit `.env.dev`.

The first start builds the OSRM routing graph (`osrm-prep` then `osrm-extract`), which can take several minutes.
The dev OSRM graph covers **north-east India (Guwahati, about 26.14, 91.73)**: every test pickup/drop must be in that
region or routing fails (the web shows a "routing unavailable" message; the api answers 503).

`pnpm dev:up:slim` starts the stack without the observability profile (no Grafana/Prometheus/Loki/Kuma).

## 3. Ports and services

| Service | Host port | Notes |
|---|---|---|
| api (NestJS) | `3000` | `GET /v1/health/live`, `/v1/health/ready`, `/metrics` |
| web (Next.js 14) | `3002` | |
| postgres (PostGIS 16) | **`55432`** | user/password/db all `rcab` |
| redis | `6379` | |
| grafana (`obs`) | `3001` | `admin` / `admin` |
| prometheus (`obs`) | `9090` | |
| uptime-kuma (`obs`) | `3003` | one-time setup: `pnpm setup:uptime-kuma` |
| OSRM, Loki, Alertmanager | **none** | reachable only inside the compose network |

Reach unpublished services through a container:

```bash
DC="docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml"
$DC exec -T api sh -c 'curl -s "http://osrm:5000/route/v1/driving/91.7362,26.1445;91.7898,26.1758"' | jq .code   # "Ok"
```

The api and web containers bind-mount the source with hot reload (`node --watch` with an SWC loader for the api,
`next dev` for the web), so edits show up without rebuilding images. Dev defaults apply only when
`NODE_ENV=development`; any other value requires a strong `JWT_SECRET` (>= 32 bytes) and `CORS_ORIGINS`, or the api
refuses to start (policy validation fails fast at boot).

## 4. Apply migrations (not automatic)

Migrations are **not** applied when a container starts or restarts:

```bash
$DC exec api npx tsx src/migrate.ts       # or the /db-migrate skill
# expect: [migrator] applied 00xx_*.sql ... [migrator] done
```

A fresh volume (after `pnpm dev:down -v`) needs this again. Details and the rules
for writing a new migration: [database-migrations.md](database-migrations.md).

## 5. Seed fixtures

```bash
./scripts/seed-dev.sh [--reset] [--drivers N] [--offline] [--keepalive]     # or /seed-db
```

Upserts fixture drivers/clients/vehicles and puts drivers in the Redis geo index around Guwahati. Caveats
(also in the `/seed-db` skill): seeded users have synthetic `firebase_uid`s and **cannot sign in through OTP**;
seeded drivers never answer an offer; and **driver presence expires** — the api sweep drops a driver whose
`last_seen` is older than 60 s, so use `--keepalive` to hold them online.

## 6. Sign in

Web (`http://localhost:3002/signin`) and the driver app use real **Firebase phone OTP**. For development without SMS,
add *test phone numbers with fixed codes* in the Firebase console (Authentication, Sign-in method, Phone). The
first successful exchange creates a `client`; making a user a driver is done through the driver registration flow
(see the driver-app videos [D01](../videos/driver-app/INDEX.md#d01)/[D02](../videos/driver-app/INDEX.md#d02)).

## 7. Driver app on an Android emulator

```bash
cd apps/driver-app
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 --dart-define=ENABLE_API_LOGGING=true
```

- `10.0.2.2` is the Android emulator's alias for the host machine; it is also the compiled-in default
  (`lib/di/providers.dart`). A physical device needs the laptop's LAN IP instead.
- Copy `google-services.json` from the Firebase console to `apps/driver-app/android/app/` (not committed).
- Mock the emulator location to Guwahati (extended controls -> Location) so OSRM can route.
- `flutter test` / `flutter analyze` need no emulator; see [testing.md](testing.md). First-time Gradle project
  generation notes are in `apps/driver-app/SETUP.md`.
- The driver app must heartbeat location while online; stop the emulator's location updates and the server forces
  you offline after 60 s (state machine: [driver presence](../state-machines.md#6-driver-presence)).

## 8. Verify and tear down

```bash
/smoke-check        # per-service health table (skill)      |  pnpm dev:smoke   (terse)
pnpm dev:logs       # follow all logs
pnpm dev:down       # stop (keeps volumes); pnpm dev:down:slim for the slim variant
```

If something does not come up, go to [debugging-and-tooling.md](debugging-and-tooling.md).
