# rcab — Claude Code session contract

This file is auto-loaded into every Claude Code session in this repo. Keep it short. The vault under `00-index/`, `10-product/`, … is the source of truth for *everything else*.

## Vault discipline (read once, every session)

The vault is selective-context: never read it all. Use the index:

1. `00-index/LLM-INSTRUCTIONS.md` — non-negotiable rules.
2. `00-index/reading-paths.md` — task → minimum note set. **Always map your task to one of its slugs and load only the listed notes (plus their `depends_on:`, depth 2). Stop.**
3. `00-index/HOME.md` — human-facing MOC, browse for orientation only.

If your task doesn't match a reading-path, add one to `reading-paths.md` first.

## Delivery layer (drives the work)

| File | Use it when |
|---|---|
| `95-delivery/delivery-roadmap.md` | Picking up a new demo / orienting on overall path |
| `95-delivery/stories-index.md` | Choosing the next story (`□ ready` only) |
| `95-delivery/demo-cadence.md` | Story-done / demo-done definitions |
| `95-delivery/hitl-touchpoints.md` | **Before risky actions — must consult.** |
| `95-delivery/commit-story-linkage.md` | Commit message shape (mandatory `Story:` trailer) |
| `95-delivery/impact-analysis.md` | Mid-flight scope change |
| `95-delivery/story-template.md` | Adding a new story file |

## Commit convention (enforced by hook)

```
<type>(<scope>): <subject>

<body — what & why>

Story: RCAB-Ex.Sy
Sign-off: <name>   # only when a demo or HITL stop signs off
```

`<type>` ∈ `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.
`<scope>` ∈ `vault`, `api`, `web`, `driver-app`, `infra`, `shared`, `ci`, or omit.

The `Story:` trailer is **mandatory** when a commit touches any non-vault path. A PreToolUse hook (`.claude/hooks/check-story-trailer.sh`) blocks `git commit` if missing; `SKIP_STORY_TRAILER=1 git commit …` is the escape hatch (vault-only commits, fixups) — use it only when the commit genuinely touches no code.

Two PostToolUse hooks also run on every Edit/Write:
- `mark-codegraph-stale.sh` — drops `codegraph/.stale` when code changes, signalling `pnpm code:graph` is due.
- `validate-vault-links.sh` — warns on dangling `[[wikilinks]]` in edited vault notes.

## Hard stops (Claude must ask before)

(Full list: `95-delivery/hitl-touchpoints.md`. Summary:)

- Installing a new system-level package (brew, apt, corepack switches).
- Creating, superseding, or revising an ADR (`99-decisions/`).
- Deploying to a real VPS (any demo ≥ 7).
- Touching secrets handling or the `secrets-management` note.
- Adding a new external service with cost/vendor lock-in.
- Bumping a demo's headline; reordering or splitting epics.
- A test going flaky enough to consider quarantine.
- A story's acceptance criteria changing mid-flight.
- Walking through any demo for sign-off.

## Phase-0 = single VPS, single docker-compose

If a story tempts you toward multi-host, Kubernetes, managed-cloud-this-or-that, stop — this is out of Phase-0 scope per `99-decisions/ADR-0009-single-vps-phase-0.md`. Flag it as an impact-analysis trigger and ask.

## Dev stack — the loop

```bash
pnpm dev:up      # docker compose up -d --build (auto-creates .env.dev on first run)
pnpm dev:smoke   # polls api / → 200 once postgres + redis are connected
pnpm dev:logs    # docker compose logs -f
pnpm dev:down    # tear down
```

Workspace: pnpm 10 (Node ≥20) + Turborepo. Driver app (`apps/driver-app/`) is Flutter and lives outside the pnpm workspace.

## Tests

Integration tests use real containers via Testcontainers (no mocks of infra). e2e: Playwright for web; Flutter `integration_test` for driver. Load: k6 in a sidecar. See `90-quality/testing-strategy.md` once you load it via a reading-path.

`pnpm verify` is the gate a story must pass before `/close-story` or `/ship-story`: `pnpm lint && pnpm policy:doc:check && pnpm --filter @rcab/api run test:cov && pnpm test:int` (coverage floor enforced by the api vitest config, per RCAB-E1.S14; `policy:doc:check` fails if `docs/POLICY.md` drifted from the policy schema). `RCAB_SKIP_INT=1 pnpm test:int` skips the container suites when Docker is unavailable — never use it to declare a story green.

## Codebase map (the code, not the vault)

Numeric dirs (`00-`…`99-`) are the Obsidian vault (docs). All shippable code lives under `apps/`, `packages/`, `infra/`, `scripts/`.

**Monorepo layout** — pnpm workspace = `apps/api`, `apps/web`, `packages/*`. `apps/driver-app` (Flutter) is outside the workspace.

- **`apps/api`** — NestJS 10 backend. Entry `src/main.ts` → `src/app.module.ts` wires everything. Two layers under `src/`:
  - `infra/` — cross-cutting providers: `db` (Drizzle+pg), `redis` (ioredis), `firebase` (admin auth), `google`.
  - `modules/` — feature modules: `auth`, `vehicles`, `drivers`, `realtime` (Socket.IO + `@socket.io/redis-adapter`), `rides`, `dispatch`, `ride-lifecycle`, `matching`, `pricing`, `rating`, `scheduled` (BullMQ delayed wake jobs), `health`.
  - `common/` — `filters` (global `AppExceptionFilter`), `middleware` (request-id, metrics), `guards`, `utils`. Global `ValidationPipe` + throttler set in `app.module.ts`.
  - DB: single schema `src/db/schema.ts`; Drizzle migrations in `apps/api/migrations/`, applied via `src/migrate.ts`. Async work via BullMQ (`@nestjs/bullmq`) on Redis. Metrics via `prom-client`, logs via `pino`.
  - HTTP routes are `/v1/*` (health probe: `/v1/health/live`).
- **`apps/web`** — Next.js 14 (App Router, `src/app/`), React 18, Zustand state, Leaflet maps, Firebase client auth, Socket.IO client. Tailwind. Shared client helpers in `src/lib/`.
- **`apps/driver-app`** — Flutter, feature-first (`lib/features/*`: auth, home, offer, ride, shared_ride, rating, earnings, profile) over `lib/core/*` (auth, location, realtime, fcm, api, driver). Riverpod DI (`lib/di`), Dio, Socket.IO, Firebase Auth.
- **`packages/shared`** — types/constants shared across api + web (`@rcab/shared`). `packages/api-client` — typed API client. `packages/test-fixtures` — DB fixtures for integration tests.
- **`infra/docker`** — compose files: `docker-compose.dev.yml` (dev), `.prod.yml` + `.prod-test.yml` (prod), `.test.yml`. Also nginx, postgres, backup, jenkins. `infra/observability` (Grafana/Prometheus, `obs` profile), `infra/load` (k6).

**Local ports (dev compose, `infra/docker/docker-compose.dev.yml`):** api `3000`, web `3002`, redis `6379`, **postgres `55432`** (not 5432 — that host port is usually a local Postgres install). Under the `obs` profile: grafana `3001`, uptime-kuma `3003`, prometheus `9090`. **OSRM, Loki and Alertmanager publish no host port** — reach them inside `rcab_dev_net` (e.g. `docker compose exec -T api sh -c 'curl http://osrm:5000/…'`), never `localhost:5000` / `localhost:3100`. `pnpm dev:up` / `dev:logs` / `dev:down` include the `obs` profile; the `:slim` variants skip it. CI is Jenkins (`Jenkinsfile`, `Jenkinsfile.nightly`).

## Commands (beyond the dev-stack loop)

Turbo drives per-package tasks; run one package with `pnpm --filter @rcab/api <script>`.

```bash
pnpm build                 # turbo build (all packages)
pnpm lint                  # turbo lint — ESLint + next lint + eslint (or use /lint for tsc + dart too)
pnpm test                  # turbo test — vitest unit across packages
pnpm test:int              # turbo test:int — Testcontainers integration (uncached)
pnpm verify                # the gate: lint + policy:doc:check + api coverage + integration
pnpm test:e2e              # turbo test:e2e — Playwright (or use /playwright-run)

# API package, targeted:
pnpm --filter @rcab/api test                       # unit
pnpm --filter @rcab/api test -- src/foo.spec.ts    # single unit file
pnpm --filter @rcab/api test:int                   # integration (vitest.config.int.ts)
pnpm --filter @rcab/api test -- -t "name"          # single test by name

# DB migrations: hand-authored SQL in apps/api/migrations/, applied by src/migrate.ts
#   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T api npx tsx src/migrate.ts
#   (prefer /db-migrate; drizzle-kit is only used for Studio, see apps/api/drizzle.config.ts)

# Fixture data for manual testing (upsert; --keepalive holds drivers online):
./scripts/seed-dev.sh [--reset] [--drivers N] [--offline] [--keepalive]
# Prod smoke test (spins prod compose, smokes, tears down):
pnpm prod:test
pnpm obs:smoke             # observability stack only (grafana/prometheus/uptime-kuma reachable)

pnpm dev:up:slim           # dev stack without the obs profile (also dev:down:slim / dev:logs has no slim)
pnpm system:probe          # host capability + load estimate (RCAB-E1.S9)
pnpm test:probe            # vitest for the probe itself (vitest.probe.config.mjs)
pnpm test:load             # k6 run infra/load/probe.js  (or /k6-load)
pnpm code:graph            # regen codegraph/  |  pnpm code:graph:check  -> vault/code drift
```

Driver-app (Flutter, outside workspace) has no pnpm scripts — use `/flutter-test` or run `flutter test` in `apps/driver-app/`.

## When in doubt

- Read `00-index/reading-paths.md` over guessing.
- Ask the user (HITL) over inventing a non-vault convention.
- Add a stub note before leaving a dangling `[[link]]`.
- Prefer the `Explore` subagent for any vault search >3 grep calls.
- A committed code graph exists: `codegraph/graph.json` (+ readable `codegraph/graph.md`). Use `/code-graph` to answer "who imports X / what does module Y depend on / where is route Z / what tables exist" instead of grepping source. Regen with `pnpm code:graph` if `codegraph/.stale` is present; `pnpm code:graph:check` flags vault/code module drift.

## Session bootstrap (new session checklist)

Every new Claude Code session in this repo should orient in under 60 seconds:

1. **CLAUDE.md** (this file) is auto-loaded — you already have it.
2. **Current epic:** check `95-delivery/stories-index.md` — the first `▶` row is work in flight, then the first `□ ready` row. E6+ rows sit at `· draft`, so a story may need `/gen-story` before it can be picked up.
3. **If continuing work:** the user will say which story. Use `/pickup-story RCAB-Ex.Sy` to orient.
4. **If starting fresh:** use `/pickup-story` (no args) to auto-pick the next ready story.
5. **Before writing any code**, the dev stack should be healthy. Run `/smoke-check` or `pnpm dev:smoke`.

Do NOT read the entire vault. The reading-paths system (`00-index/reading-paths.md`) tells you exactly which notes to load for any task. The `/pickup-story` skill does this automatically for stories.

## Project skills (this repo)

### Story lifecycle (use in order)
- `/pickup-story RCAB-Ex.Sy` — orient on a ready story, load minimum context, state AC back, flip to in_progress.
- `/new-branch RCAB-Ex.Sy` — create a feature branch from up-to-date main.
- `/close-story RCAB-Ex.Sy` — verify tests, check vault links, flip status to done, draft commit.
- `/ship-story RCAB-Ex.Sy [--merge]` — commit + push + PR + optional merge. The full post-implementation flow.
- `/merge-pr [PR#]` — safe merge with conflict resolution and local cleanup.
- `/flip-status RCAB-Ex.Sy <in_progress|done>` — atomic 3-file status flip (used by other skills internally).
- `/gen-story RCAB-Ex.Sy <slug>` — generate a new story from template, add to index + epic.

### Dev stack & health
- `/smoke-check` — per-service health table (containers + endpoints + latency).
- `/api-smoke` — targeted API endpoint probe with latency breakdown.
- `/env-validate` — diff .env files against env.example, catch missing keys.
- `/validate-compose` — validate all docker-compose file combinations parse correctly.
- `/redis-inspect` — inspect driver geo-index, BullMQ queues, JWT revocation state.
- `/pool-inspect` — inspect shared-ride pool state in Redis (E5+): open pools, seat counts, expiry timers, BullMQ depth.
- `/osrm-check` — verify OSRM container loaded its graph and can route; run before any E4/E5 story.
- `/docker-stats` — snapshot per-container CPU/memory vs. Phase-0 VPS budget.
- `/drizzle-studio` — launch Drizzle Studio for visual schema browsing.
- `/db-migrate [generate|migrate|status]` — Drizzle ORM migration workflow with dry-run preview.
- `/seed-db [--reset] [--scenario=<name>]` — seed dev DB with fixture drivers/clients/vehicles; scenarios: `default`, `shared-ride`, `load-test`.

### Testing
- `/flutter-test [unit|widget|integration|all]` — run Flutter tests for the driver app (outside pnpm workspace).
- `/playwright-run [spec] [--headed] [--video]` — Playwright e2e with optional video for demo sign-off.
- `/k6-load [scenario]` — k6 load test + compare against Phase-0 performance budget.
- `/coverage` — vitest coverage (API) + flutter coverage; summary table with 80%/70% quality gates.

### Codebase navigation
- `/code-graph` — query the committed code graph instead of grepping (`importers <file>`, `deps <Module>`, `route <METHOD /path>`, `tables`, `symbol <Name>`, `modules`, `regen`).

### Quality & CI
- `/lint` — ESLint + tsc type-check (api + web) + Dart analyzer + Prettier check in one pass.
- `/security-scan` — npm audit + secret scan + OWASP patterns, mapped to vault security checklist.
- `/babysit-prs` — poll open PRs for CI status. Use with `/loop 5m /babysit-prs` for monitoring.
- `/code-review [--fix]` — review current diff for correctness and cleanup.
- `/security-review` — security review of pending changes.

## Project MCPs

- **context7** — library/framework docs lookup. Use for NestJS, Drizzle, Next.js, Flutter, Socket.IO questions.
- **github** — GitHub API access for PRs, issues, CI checks. Complements `gh` CLI in skills.
- **redis** — direct Redis inspection. Complements `/redis-inspect` skill for ad-hoc queries.
- **playwright** — browser control for web app testing and demo walkthroughs.
- **postgres** (global) — direct Postgres queries. Use for ad-hoc data inspection beyond Drizzle Studio.

## Current project state

**`95-delivery/stories-index.md` is the only source of truth** (`■ done` `▶ in_progress` `□ ready` `· draft` `× blocked`). The snapshot below goes stale — read that file, don't trust this.

- **Done:** E1 Foundation, E2 Auth & Identity, E3 Driver Presence, E4 Normal Booking (Demo 3), E5 Shared Booking (Demo 4).
- **In flight:** E6 Scheduled Booking → Demo 5 — all four stories shipped (PRs #28–#31) and the index now reads `■`. The only open gate is the Demo-5 sign-off walk (HITL) — don't mark Demo 5 done without it.
- **Migrations are hand-authored SQL** in `apps/api/migrations/` (latest `0017`, `pool_member.agreed_fare_cents`; apply 0012-0017 on existing dev DBs) and are **not** applied on container restart: `docker compose exec api npx tsx src/migrate.ts` (or `/db-migrate`).
- **Dev runner is `node --watch` + SWC loader** (not tsx; tsx drops decorator metadata). `JWT_SECRET`/`CORS_ORIGINS` default only when `NODE_ENV` is `development`/`test`; otherwise the api fails closed at startup. Idempotency is in Postgres, not Redis (`idem:rides:*` removed).
- **Dispatch is outbox-driven** (Stage C): intents are written to `outbox` in the booking/pool transaction; offers, driver assignment and pool membership are authoritative in Postgres, and the Redis `driver:state.current_ride_id` / `pool:<id>` entries are projections reconciled from Postgres (the old `claim:ride:*`/`offer:*` keys and pool Lua scripts are gone).
- **Driver presence expires:** the api auto-offline sweep (every 15 s) drops any driver whose `driver:state:<id>.last_seen` is older than 60 s. Seeded fixture drivers need `./scripts/seed-dev.sh --keepalive` to stay in the `active_drivers` geo index.
- **Refresh-token revocation is in Postgres** (`auth_refresh_token.revoked_at`), not Redis.
- **Auth (RCAB-E8.S15):** sign-in/registration is Google-only until launch (`auth.enabledMethods`, `GET /v1/auth/config`); phone OTP is disabled behind the flag, see ADR-0003 amendment 2026-11-10.
- **Next up:** E7 Rating & dashboards (rating capture landed in E4.S9; aggregation is E7.S2), then E8 hardening, E9 pilot.
- **Tech stack:** NestJS API + Next.js web + Flutter driver app + Postgres + Redis + OSRM, Phase-0 single VPS.

## Human-facing docs (outside the vault)

- `docs/ARCHITECTURE.md` — code-level architecture write-up.
- `docs/manual-testing/RUN-GUIDE.md` + `demo-walkthrough.md` + `technical-guide.md` — how to bring the stack up and walk a demo by hand.
