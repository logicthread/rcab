# rcab

Ride-hailing for tier-2/3 Indian cities: private rides, shared rides on common routes, and scheduled rides.
Passengers use the web app; drivers use the Flutter Android app.

| Part | Stack | Where |
|---|---|---|
| API | NestJS 10, Drizzle (Postgres/PostGIS), Redis, BullMQ, Socket.IO | `apps/api` |
| Passenger web app | Next.js 14, React 18, Zustand, Leaflet | `apps/web` |
| Driver app | Flutter (Android), Riverpod, Dio | `apps/driver-app` |
| Routing | OSRM (north-east India graph in dev) | container |
| Observability | Prometheus, Grafana, Loki, Alertmanager, Uptime Kuma | `infra/observability` |

This README takes you from a fresh clone to a running stack, a signed-in passenger, a driver on an emulator, and
a green test gate. For deeper material see [Where to go next](#where-to-go-next).

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone and install](#2-clone-and-install)
3. [Configure `.env.dev`](#3-configure-envdev)
4. [Start the stack](#4-start-the-stack)
5. [Use the app](#5-use-the-app)
6. [Driver app](#6-driver-app)
7. [Develop](#7-develop)
8. [Troubleshooting](#8-troubleshooting)
9. [Where to go next](#where-to-go-next)

---

## 1. Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Docker Desktop (or Engine + Compose v2) | recent, **running** | the dev stack and integration tests (Testcontainers) |
| Node.js | ≥ 20 (developed on 22) | the pnpm workspace |
| pnpm | 10 (`packageManager` pins `pnpm@10.33.4`) | `corepack enable pnpm` |
| git | any | |
| Flutter | ≥ 3.22 | driver app only |
| Android Studio + SDK + one emulator (AVD) | recent | driver app only; also provides `keytool` |
| A Google account | | creating OAuth clients and signing in |
| k6 | recent | load tests only |

Disk and time: the first start downloads a ~100 MB OpenStreetMap extract and builds the routing graph (5–10 min).
Docker should have at least 6 GB of memory.

**Host ports used:** api `3000`, web `3002`, redis `6379`, **postgres `55432`** (not 5432, which is usually a
local Postgres), grafana `3001`, uptime-kuma `3003`, prometheus `9090`. Free them before starting.

> **`pnpm: command not found` in scripts or tools?** If Node is managed by fnm/nvm, non-interactive shells may not
> see it. Prefix: `export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"` (fnm default alias).

---

## 2. Clone and install

```bash
git clone https://github.com/logicthread/rcab.git
cd rcab
pnpm install          # apps/api, apps/web, packages/* (the Flutter app is not in the pnpm workspace)
```

---

## 3. Configure `.env.dev`

```bash
cp .env.dev.example .env.dev     # pnpm dev:up does this for you if the file is missing
```

`.env.dev` is gitignored; never commit it. The defaults run the whole stack. The one thing you must add to
**sign in** is a Google OAuth client ID.

### Google sign-in (one-time, per Google Cloud project)

Sign-in and registration are **Google-only** until launch (phone OTP is off behind the policy flag
`auth.enabledMethods`; see `99-decisions/ADR-0003-otp-firebase.md`). The team's dev project is `rcab-dev`; ask the
owner for its client IDs, or set up your own project:

1. [Google Cloud Console](https://console.cloud.google.com/) → **Google Auth Platform**
   → **Get started**: app name, support email, audience **External**, contact email.
2. **Audience → Test users → Add users**: add every Google account that will sign in. While the app is in
   *Testing*, only these accounts can sign in (publishing needs a public home page, privacy policy and domain).
3. **Clients → Create client → Web application**. Authorized JavaScript origins: `http://localhost:3002` and
   `http://localhost`. No redirect URI is needed. Copy the client ID. (The secret is not used.)
4. **Clients → Create client → Android** (only for the driver app): package `com.rcab.driver_app`, SHA-1 of your
   debug keystore:

   ```bash
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey \
     -storepass android -keypass android | grep SHA1
   # no keytool on PATH? use "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"
   ```

5. In `.env.dev`:

   ```bash
   GOOGLE_CLIENT_IDS=<web client id>,<android client id>   # web FIRST
   ```

The web and driver apps fetch the web client ID from `GET /v1/auth/config`, so they need no extra setting.
Without a client ID the API still starts and Google sign-in answers `503 google_not_configured`.

Other variables (`JWT_SECRET`, `FIREBASE_*`, `OSM_PBF_URL`) are documented in `.env.dev.example`. In dev
(`NODE_ENV=development`) `JWT_SECRET` and `CORS_ORIGINS` have safe defaults; Firebase is only needed if you turn
phone OTP back on.

---

## 4. Start the stack

```bash
pnpm dev:up          # docker compose up -d --build, incl. the observability profile
pnpm dev:smoke       # waits until the api answers 200 with postgres, redis and osrm connected
```

The first `dev:up` takes about 7–10 minutes: it builds the images, downloads the map extract and builds the
routing graph, and returns only when the routing server has started. Later starts reuse the cached volumes and
take seconds.

`pnpm dev:up:slim` skips the observability containers (lighter on memory).

### Apply database migrations (not automatic)

Migrations are hand-written SQL in `apps/api/migrations/`. They are **not** applied when containers start. Run
them after the first start and whenever you pull new migrations:

```bash
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T api npx tsx src/migrate.ts
# [migrator] running migrations...  [migrator] done   (safe to re-run; applied files are skipped)
```

### Check it is up

```bash
curl -s localhost:3000/v1/health/ready      # postgres, redis, osrm all ok (osrm only once its graph is built)
curl -s localhost:3000/v1/auth/config       # {"methods":["google"],"google":{"clientId":"<web client id>"}}
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml ps
```

`health/ready` reports `"osrm":false` for a few seconds after start while the routing server loads its graph.

| URL | What |
|---|---|
| http://localhost:3002 | passenger web app |
| http://localhost:3000/v1/health/live | api liveness |
| http://localhost:3001 | Grafana (`admin` / `admin`) |
| http://localhost:9090 | Prometheus |
| http://localhost:3003 | Uptime Kuma (first run: `pnpm setup:uptime-kuma`) |

OSRM, Loki and Alertmanager have no host port; reach them from inside the network, e.g.
`docker compose … exec -T api sh -c 'curl -s http://osrm:5000/…'`.

### Fixture data (optional)

```bash
./scripts/seed-dev.sh                 # 3 online fixture drivers + clients + vehicles around Guwahati
./scripts/seed-dev.sh --keepalive     # same, and keep the drivers online (foreground, Ctrl-C to stop)
./scripts/seed-dev.sh --reset         # remove previously seeded rows first
```

Seeded users cannot sign in and never accept offers; they exist so dispatch has candidates and lists have data.
The api marks a driver offline after 60 s without a location update, so use `--keepalive` while you need them.

### Stop

```bash
pnpm dev:down                         # stop, keep data
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml --profile obs down -v   # also wipe data
```

---

## 5. Use the app

**Region:** the dev routing graph covers **north-east India**. Pickups and drop-offs must be there (Guwahati is
around `26.14, 91.73`), otherwise quotes fail with "routing unavailable".

1. **Passenger:** open http://localhost:3002/signin → **Continue with Google**. The first sign-in creates a
   passenger account. Then **Book a ride**: set pickup and drop on the map, choose **Share** or **Private**, and **Now** or **Later** (a scheduled ride).
2. **Driver:** sign in once in the driver app (or the web) with the Google account that will drive, then promote
   it:

   ```bash
   ./scripts/provision-driver.sh you@gmail.com --vehicle-reg AS01AB1234 --dry-run   # preview
   ./scripts/provision-driver.sh you@gmail.com --vehicle-reg AS01AB1234
   ```

   In the driver app tap **Retry** on the "Not registered as a driver yet" screen.
3. **Ride:** driver goes online, passenger books nearby, driver accepts the offer and moves the ride through
   en route → arrived → started → completed; both sides rate each other.

Videos of every flow: `docs/onboarding/videos/` (web, driver, ops), indexed in each `INDEX.md`.

---

## 6. Driver app

```bash
cd apps/driver-app
flutter pub get
flutter analyze
flutter test                                   # unit + widget tests, no emulator needed
```

Run on an emulator (start the AVD from Android Studio, or `emulator -avd <name>`):

```bash
flutter run                                    # API defaults to http://10.0.2.2:3000 (the host, from the emulator)
flutter run --dart-define=API_BASE_URL=http://192.168.1.20:3000   # physical device: your laptop's LAN IP
```

- `android/app/google-services.json` is **not committed**. Download it from the Firebase console (project
  settings → Android app `com.rcab.driver_app`) and put it there; the build fails without it.
- Google sign-in on the emulator needs a Google account added to the emulator (Settings → Accounts), a system
  image **with Google Play**, and that account in the consent screen's test users.
- Set the emulator location to Guwahati (Extended controls → Location) so routing works. The app must keep sending
  locations while online, or the server takes the driver offline after 60 s.
- Optional: `--dart-define=GOOGLE_SERVER_CLIENT_ID=<web client id>` is only a fallback when `/v1/auth/config` is
  unreachable.

More: `apps/driver-app/README.md`, `apps/driver-app/SETUP.md`.

---

## 7. Develop

### The loop

The `api` and `web` containers bind-mount the source and hot-reload (`node --watch` with SWC for the api,
`next dev` for the web). Edit, save, refresh. Rebuild images (`pnpm dev:up`) only after dependency changes.

### Commands

| Command | What it does |
|---|---|
| `pnpm build` | build every TS package (turbo, dependency order) |
| `pnpm lint` | ESLint / next lint across the workspace |
| `pnpm test` | unit tests (vitest) |
| `pnpm --filter @rcab/api test -- src/foo.spec.ts` | one api unit file (`-t "name"` for one test) |
| `pnpm test:int` | integration tests on real Postgres/Redis via Testcontainers (Docker must run) |
| `pnpm test:e2e` | Playwright e2e for the web (needs the dev stack) |
| **`pnpm verify`** | **the gate**: lint + policy doc check + api unit tests with coverage floor + integration |
| `pnpm policy:doc` | regenerate `docs/POLICY.md` after changing a policy knob |
| `pnpm code:graph` | regenerate the code graph in `codegraph/` |
| `pnpm test:load` | k6 load test |
| `cd apps/driver-app && flutter test` | driver app tests |

`pnpm verify` must be green before a change is done. `RCAB_SKIP_INT=1 pnpm test:int` skips the container suites
when Docker is unavailable — never use it to call something green.

### Where things live

```
apps/api/src/
  modules/       auth, rides, dispatch, matching, pricing, ride-lifecycle, scheduled, rating, realtime, …
  infra/         db (Drizzle + pg), redis, google, firebase
  config/policy/ policy.schema.ts  ← every business knob (fares, wait times, radii, auth methods)
  db/schema.ts   the single Drizzle schema
apps/api/migrations/   hand-written SQL, numbered 0000_…
apps/web/src/          app/ (routes), lib/ (api client, stores)
apps/driver-app/lib/   features/* over core/*
packages/              shared (types), api-client, test-fixtures
infra/docker/          compose files (dev / test / prod), nginx, postgres, backup, jenkins
scripts/               dev-up, seed-dev, provision-driver, deploy/, recovery/, demo/
```

### Common changes

- **Business rule** (fare, max wait, radius, retry cutoff): edit `apps/api/src/config/policy/policy.schema.ts`,
  then `pnpm policy:doc`. The generated `docs/POLICY.md` lists every knob, its env override and default.
- **Database change:** add the next `apps/api/migrations/00NN_<name>.sql`, mirror it in `src/db/schema.ts`, apply
  with `src/migrate.ts`. Rules: `docs/onboarding/workflows/database-migrations.md`.
- **New endpoint / feature end to end:** `docs/onboarding/workflows/adding-a-feature-end-to-end.md`.

### Commits and stories

Work is organised as stories (`95-delivery/stories-index.md`). Commit messages follow
`<type>(<scope>): <subject>` and **must** carry a `Story: RCAB-Ex.Sy` trailer when they touch code (a hook
enforces it). Details: `95-delivery/commit-story-linkage.md`. Architecture decisions live in `99-decisions/`;
changing one needs the owner's approval. CI is Jenkins (`Jenkinsfile`, `Jenkinsfile.nightly`).

### Documentation vault

The numbered folders (`00-index/` … `99-decisions/`) are an Obsidian vault and the source of truth for product,
domain and architecture. Start at `00-index/HOME.md`; `00-index/reading-paths.md` maps a task to the notes to read.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm install` warns "Ignored build scripts: msgpackr-extract" | harmless; BullMQ falls back to the JS implementation |
| `port is already allocated` on `dev:up` | another process holds 3000/3002/55432/6379/3001/3003/9090; stop it |
| api 500s mentioning a missing column/table | migrations not applied: run `src/migrate.ts` (section 4) |
| quote says "routing unavailable" / api 503 on quote | the points are outside north-east India, or OSRM is not up (`curl -s localhost:3000/v1/health/ready`) |
| `google_not_configured` | `GOOGLE_CLIENT_IDS` empty in `.env.dev`; set it, then `docker compose … up -d api` |
| Google popup: "Access blocked" / "app not verified" | account not in the consent screen's test users, or origin `http://localhost:3002` missing on the web client |
| driver app "Not registered as a driver yet" | run `scripts/provision-driver.sh <email>`, then Retry |
| seeded drivers vanish after a minute | expected; use `./scripts/seed-dev.sh --keepalive` |
| `pnpm verify` integration failures about Docker | start Docker Desktop; Testcontainers needs it |
| driver app build: missing `google-services.json` | download it from the Firebase console (section 6) |

More: `docs/onboarding/workflows/debugging-and-tooling.md`.

---

## Where to go next

| Doc | For |
|---|---|
| `docs/onboarding/README.md` | onboarding pack: system overview, functionality, state machines, role guides, videos |
| `docs/ARCHITECTURE.md` | code-level architecture |
| `docs/POLICY.md` | every business knob (generated) |
| `docs/manual-testing/RUN-GUIDE.md` | walking every demo by hand |
| `docs/operations/recovery-runbook.md` | backups, restore and recovery drills |
| `95-delivery/delivery-roadmap.md` | what is built, what is next |
