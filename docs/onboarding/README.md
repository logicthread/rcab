# rcab onboarding pack

Start here. This pack lets a new team take over rcab: what the system is, how every part behaves, how to work on it, and recordings of every user-facing and operator-facing workflow. It was produced under story `RCAB-E8.S14` and is checked against the code; where a vault note and the code disagree, the code wins and the drift is noted.

## What rcab is

rcab is a Phase-0 ride-hailing platform for tier-2/3 Indian cities. Passengers book on a **web app** (private, shared or scheduled rides), drivers work in a **Flutter Android app**, and one **NestJS API** matches, dispatches and tracks trips over **Postgres** (system of record), **Redis** (geo index, queues, projections) and a self-hosted **OSRM** router, with Firebase phone-OTP for identity. Everything runs on one VPS under one docker-compose (ADR-0009). Metrics, logs, dashboards and uptime checks are part of the stack.

Status in one line: epics E1 to E6 shipped (Demo 5 sign-off walk still owed), E7 (rating aggregation, history, earnings) and E9 (pilot) not started, E8 (hardening) in flight. `95-delivery/stories-index.md` is the source of truth.

## Which guide do I read?

Read this README, then [01 System overview](01-system-overview.md), then your role guide. Every guide links onward to the workflows, functionality pages, state machines and video IDs it relies on.

| If you are... | Read | You will mostly use |
|---|---|---|
| **UI/UX developer** (web and driver app screens) | [guides/ui-ux-dev.md](guides/ui-ux-dev.md) | [normal-booking](functionality/normal-booking.md), [shared-rides](functionality/shared-rides.md), [realtime-protocol](functionality/realtime-protocol.md), web and driver videos |
| **Backend developer** | [guides/backend-dev.md](guides/backend-dev.md) | all [functionality pages](functionality/), [state machines](state-machines.md), [workflows](workflows/README.md) |
| **Stakeholder: passenger web app** (product, support) | [guides/stakeholder-user-app.md](guides/stakeholder-user-app.md) | [web videos](videos/web/INDEX.md) W01 to W10 |
| **Stakeholder: driver app** (driver managers, trainers) | [guides/stakeholder-driver-app.md](guides/stakeholder-driver-app.md) | [driver videos](videos/driver-app/INDEX.md) D01 to D08 |
| **Stakeholder: maintainer** (day-to-day operations) | [guides/stakeholder-maintainer.md](guides/stakeholder-maintainer.md) | [ops videos](videos/ops/INDEX.md) M01 to M06, [admin-and-observability](functionality/admin-and-observability.md) |
| **Stakeholder: monitoring and on-call** | [guides/stakeholder-monitoring.md](guides/stakeholder-monitoring.md) | [ops videos](videos/ops/INDEX.md), [incident-and-recovery](workflows/incident-and-recovery.md) |
| **Monitoring and maintenance developer** | [guides/monitoring-maintenance-dev.md](guides/monitoring-maintenance-dev.md) | [admin-and-observability](functionality/admin-and-observability.md), [idempotency-and-durability](functionality/idempotency-and-durability.md), [recovery runbook](../operations/recovery-runbook.md) |
| **DevOps developer** | [guides/devops-dev.md](guides/devops-dev.md) | [release-and-deploy](workflows/release-and-deploy.md), [`scripts/deploy/README.md`](../../scripts/deploy/README.md), [recovery runbook](../operations/recovery-runbook.md) |
| **Senior architect** | [guides/senior-architect.md](guides/senior-architect.md) | [01 System overview](01-system-overview.md), [state machines](state-machines.md), [stage-c contract](../remediation/stage-c-contract.md) |
| **Manager** | [guides/manager.md](guides/manager.md) | this README, [01 System overview](01-system-overview.md) sections 1 and 2, the videos |

## How the pack is organised

```
docs/onboarding/
  README.md                this page
  01-system-overview.md    product and Phase-0 scope, components, diagrams, request lifecycle, invariants, repo map, glossary
  state-machines.md        every state machine, derived from the code (ride, pool, offer, presence, session, ...)
  guides/                  one onboarding guide per role (table above)
  workflows/               one file per development workflow: setup, story lifecycle, testing, migrations, config, ...
  functionality/           one file per product/system area (below)
  videos/
    web/INDEX.md           W01 to W10  passenger web app recordings
    driver-app/INDEX.md    D01 to D08  driver app recordings
    ops/INDEX.md           M01 to M06  operator and monitoring recordings
```

### Functionality pages

Each page states what the area does, user-visible behaviour, API and socket surface, tables, the policy knobs that govern it, code entry points, tests, related video IDs and **known gaps**.

| Page | Area |
|---|---|
| [auth-and-sessions](functionality/auth-and-sessions.md) | Phone OTP, access and refresh tokens, web cookie vs native contract, rotation, logout, account status |
| [driver-onboarding-and-presence](functionality/driver-onboarding-and-presence.md) | Making a driver, vehicles, online toggle, geo index, auto-offline sweep |
| [quoting-and-pricing](functionality/quoting-and-pricing.md) | Solo fare formula, quote tokens, shared seat pricing, the fixed-at-join stand-in (E8.S9 pending) |
| [normal-booking](functionality/normal-booking.md) | The private-ride path end to end |
| [dispatch-and-offers](functionality/dispatch-and-offers.md) | Waves, offers, the accept transaction, assignment guard, timers, reconciler |
| [shared-rides](functionality/shared-rides.md) | Matching, pool lifecycle, membership, itinerary, optimistic pricing |
| [scheduled-rides](functionality/scheduled-rides.md) | Wake at T-10, 4-minute window, retry, cutoff |
| [ride-lifecycle-cancel-no-show](functionality/ride-lifecycle-cancel-no-show.md) | Forward transitions, cancel rules, no-show |
| [realtime-protocol](functionality/realtime-protocol.md) | Rooms, subscribe and snapshots, versions, full event catalogue |
| [ratings](functionality/ratings.md) | Two-sided rating capture (aggregation is E7) |
| [idempotency-and-durability](functionality/idempotency-and-durability.md) | Idempotency keys, transactional outbox, relay, reconciler |
| [admin-and-observability](functionality/admin-and-observability.md) | Health and version endpoints, metrics, logs, dashboards, alerts, operator tooling |

### Videos

Recordings are produced by re-runnable harnesses (`pnpm demo:record:web`, `scripts/demo/record-driver.sh`, `pnpm demo:record:ops`). Files live at `docs/onboarding/videos/<area>/<ID>-<slug>.mp4`; each area has an `INDEX.md` listing the exact file names, durations and what each scene shows.

| ID | Scene | Index |
|---|---|---|
| W01 to W10 | landing, sign-in screen, normal ride full lifecycle, passenger cancel, driver no-show or cancel, no driver available, shared ride with two passengers, scheduled ride, reload and reconnect, sign out | [videos/web/INDEX.md](videos/web/INDEX.md) |
| D01 to D08 | sign-in, vehicle registration, go online and presence, solo offer to rating, decline/expiry/lost, shared offer and stops, cancel and no-show, earnings and profile | [videos/driver-app/INDEX.md](videos/driver-app/INDEX.md) |
| M01 to M06 | Grafana dashboards, Prometheus targets and a business query, Loki by request id, Uptime Kuma, Alertmanager, dev tooling and drills (terminal recordings) | [videos/ops/INDEX.md](videos/ops/INDEX.md) |

Scene to documentation map: W03/D04 [normal-booking](functionality/normal-booking.md); W04, W05, D07 [lifecycle](functionality/ride-lifecycle-cancel-no-show.md); W06, D05 [dispatch](functionality/dispatch-and-offers.md); W07, D06 [shared-rides](functionality/shared-rides.md); W08 [scheduled-rides](functionality/scheduled-rides.md); W09 [realtime-protocol](functionality/realtime-protocol.md); W02, W10, D01 [auth](functionality/auth-and-sessions.md); D02, D03 [presence](functionality/driver-onboarding-and-presence.md); M01 to M06 [admin-and-observability](functionality/admin-and-observability.md).

## First hour

1. Skim [01 System overview](01-system-overview.md) (10 minutes) and the diagrams in [state-machines](state-machines.md).
2. Follow [workflows/local-setup.md](workflows/local-setup.md) to bring the stack up (`pnpm dev:up`, `pnpm dev:smoke`) and run `pnpm verify` once.
3. Watch the videos for your role.
4. Read the functionality pages for the area you will touch; read its **Known gaps** before you change it.
5. Before writing code, read [workflows/story-lifecycle.md](workflows/story-lifecycle.md): work is organised in stories (`RCAB-Ex.Sy`), commits need a `Story:` trailer, and a few actions are human-in-the-loop stops.

## Existing documents this pack points to (it does not duplicate them)

| Document | What it is |
|---|---|
| [`CLAUDE.md`](../../CLAUDE.md) | Session contract for Claude Code in this repo: vault discipline, hard stops, commands, ports |
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | Code-verified architecture and interface reference |
| [`docs/POLICY.md`](../POLICY.md) | Every business knob (fares, radii, TTLs, windows, rate limits), generated by `pnpm policy:doc` |
| [`docs/manual-testing/RUN-GUIDE.md`](../manual-testing/RUN-GUIDE.md) | Hands-on bring-up and demo walks 0 to 5 |
| [`docs/operations/recovery-runbook.md`](../operations/recovery-runbook.md) | Backups, restore drill, Redis-loss drill, what is proven and not |
| [`docs/remediation/stage-c-contract.md`](../remediation/stage-c-contract.md) | The concurrency and durability contract (lock order, outbox, invariant SQL) |
| [`scripts/deploy/README.md`](../../scripts/deploy/README.md) | Immutable-image release, verified deploy, rollback |
| [`00-index/HOME.md`](../../00-index/HOME.md) and [`00-index/reading-paths.md`](../../00-index/reading-paths.md) | Obsidian vault map and the task-to-notes index (never read the whole vault) |
| `.claude/skills/*` | Project skills: `/pickup-story`, `/smoke-check`, `/db-migrate`, `/seed-db`, `/redis-inspect`, `/pool-inspect`, `/code-graph`, ... |
| `codegraph/graph.md` | Generated module, route and table graph (`pnpm code:graph`) |
| [`docs/manual-testing/technical-guide.md`](../manual-testing/technical-guide.md) | Superseded early guide; kept for history only |

## Things to know on day one

- **Drivers cannot self-register.** A phone sign-in always makes a passenger; an operator promotes an account in SQL ([driver-onboarding-and-presence](functionality/driver-onboarding-and-presence.md)).
- **The web app cannot book a scheduled ride yet**, and a shared pool is not restored on reload ([scheduled-rides](functionality/scheduled-rides.md), [shared-rides](functionality/shared-rides.md)).
- **Migrations are not applied on restart.** Run the migrator explicitly ([workflows/database-migrations.md](workflows/database-migrations.md)).
- **Seeded drivers vanish after 60 s** without `./scripts/seed-dev.sh --keepalive` (auto-offline sweep).
- **Service logs are currently mostly silent**: Nest `Logger` output is discarded; only request lines reach stdout and Loki ([admin-and-observability](functionality/admin-and-observability.md), known gap 1).
- **No payments, no cancellation fee, no earnings, no ratings aggregation** in Phase-0.
- **Postgres is on host port 55432**, not 5432. OSRM, Loki and Alertmanager have no host port.
- Human-in-the-loop stops (ADRs, secrets, real VPS deploys, demo sign-off, ...) are listed in `95-delivery/hitl-touchpoints.md`; read it before any risky action.
