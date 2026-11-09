# Onboarding guide: DevOps developer

You own how rcab is built, shipped and kept running: the compose stacks, Docker images, Jenkins
pipelines, the release scripts, the VPS bootstrap, TLS, backups and the limits of the Phase-0
topology. The hard constraint is **ADR-0009: one VPS, one docker-compose, no Kubernetes, no managed
cloud services**. If a task tempts you toward multi-host, flag it as an impact-analysis trigger and ask.

Back to the [onboarding index](../README.md). Facts were checked against the files named below on branch
`onboarding/walkthrough`. **Nothing here has been run against a real production VPS**: the release path was
rehearsed locally (`scripts/deploy/rehearse-local.sh`) and the recovery drills ran on fixture data. Treat
"proven" claims accordingly.

---

## 1. Day-1 / week-1 checklist

### Day 1: run the dev stack

1. Read [`CLAUDE.md`](../../../CLAUDE.md), [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) section 2 (topology and
   ports), then [`scripts/deploy/README.md`](../../../scripts/deploy/README.md) and
   [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md).
2. Needs Docker Desktop (Compose v2), Node 20+, pnpm 10, `k6` for load tests, `openssl`.
3. Start and verify:

   ```bash
   pnpm install
   pnpm dev:up            # docker compose up -d --build, auto-creates .env.dev, includes the `obs` profile
   pnpm dev:smoke         # api / -> 200 once postgres + redis are connected
   pnpm obs:smoke         # Prometheus has data
   /validate-compose      # (skill) every compose file combination still parses
   ```

   Dev host ports: api 3000, web 3002, redis 6379, **postgres 55432**, Grafana 3001, Prometheus 9090, Uptime Kuma
   3003. OSRM, Loki and Alertmanager have **no** host port (compose network `rcab_dev_net` only). The first run
   downloads the OSM extract and builds the OSRM graph (NE India, a few minutes).
4. Migrations are not applied on container start:
   `docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts`.
5. Watch the ops videos ([`../videos/ops/INDEX.md`](../videos/ops/INDEX.md), M01 to M06; M06 shows the terminal
   tooling: smoke check, redis and pool inspect, restore drill).

### Week 1: first prod-like run and first change

| Step | Command | Notes |
|---|---|---|
| Prod-like stack, self-signed certs | `pnpm prod:test` | `prod:up` (generates a throwaway Firebase key, builds images tagged `prodtest`), `prod:smoke`, `obs:smoke`, then `prod:down -v`. Needs several GB and a few minutes. |
| Release rehearsal, no SSH | `bash scripts/deploy/rehearse-local.sh` | full release and rollback scenario against a throwaway project `rcab-sim` |
| Backup and restore rehearsal | `scripts/recovery/backup-rehearsal.sh` | real backup image, encryption, retention, restore, corruption detection; no secrets |
| Redis-loss drill | `scripts/recovery/redis-loss-drill.sh` | own compose project, loopback ports 13000/15432/16379 |
| Local pipeline checks | `pnpm lint && pnpm policy:doc:check`, `pnpm --filter @rcab/api run test:artifact` | same as Jenkins stages |
| Full gate | `pnpm verify` | lint + policy drift + api coverage + integration |

First small change (suggested): add a missing `healthcheck` or pin an image digest in one compose file, run
`/validate-compose`, then `pnpm prod:test`. Compose changes are cheap to break and expensive to find on the VPS,
so always run `prod:test` for anything that touches `docker-compose.prod.yml` or nginx.

---

## 2. What you own and the mental model

### The compose files (`infra/docker/`)

| File | Purpose | Notes |
|---|---|---|
| `docker-compose.dev.yml` | Developer stack (`name: rcab-dev`) | Bind-mounts api/web for hot reload; observability under profile `obs`; `pnpm dev:up` includes `obs`, `dev:up:slim` skips it |
| `docker-compose.test.yml` | Plain Postgres/Redis (+ optional OSRM profile) for manual runs | `pnpm test:int` does **not** use it; Testcontainers starts its own |
| `docker-compose.prod.yml` | The production stack (`name: rcab-prod`) | nginx, api, web, migrator, postgres, redis, osrm, backup, jenkins, certbot, loki, promtail, prometheus, alertmanager, grafana, uptime-kuma. Images for third-party services are pinned by digest. |
| `docker-compose.prod-test.yml` | CI override of prod | self-signed certs, inline env, images built from source under tag `prodtest` |
| `docker-compose.release-sim.yml` | Stand-in "VPS" for `rehearse-local.sh` | project `rcab-sim`, remapped loopback ports, stub OSRM |
| `docker-compose.recovery-drill.yml` | Disposable stack for the Redis-loss drill | own project, volumes removed on teardown |

Other things in `infra/docker/`: `api/Dockerfile.{dev,prod}`, `web/Dockerfile.{dev,prod}`, `nginx/`
(`nginx.conf`, `conf.d/{api,app,default}.conf`, `snippets/`), `postgres/` (PostGIS 16 image + `init.sql`),
`backup/` (cron + `backup.sh` + `entrypoint.sh`), `jenkins/Dockerfile`, `env.example/*.env.example`.
Observability config is in `infra/observability/`; load tests in `infra/load/`.

### Production topology (Phase-0)

```
Internet :80/:443 -> nginx (TLS, rate limit zone api_limit 60 r/min burst 20 on /v1/)
                      |-- api.<domain>  -> api:3000 (HTTP + /socket.io/)
                      |-- app.<domain>  -> web:3000
                      +-- everything else 308 -> app host
Private network rcab_net: api, web, postgres, redis(password), osrm, backup, loki, promtail, prometheus,
                          alertmanager, grafana, uptime-kuma, jenkins (127.0.0.1:8080 only), certbot
Host: /opt/rcab/{infra,compose,secrets,backups}   Volumes: pg-data redis-data osrm-data certbot-* loki/prom/grafana/kuma data
```

Only nginx publishes ports (80, 443); Jenkins is bound to loopback. Postgres, Redis and every observability tool
are unreachable from outside by design.

### The release model (RCAB-E8.S11)

Images are **immutable and built once per commit**: `ghcr.io/logicthread/rcab-api:<sha>` and `rcab-web:<sha>`, no
`latest`. The SHA is baked in (OCI label, `RCAB_VERSION` build arg) and reported by `GET /v1/health/version` (api)
and `/version.json` (web). `docker-compose.prod.yml` requires `RCAB_VERSION` (no default).

```
Jenkinsfile (main, release/**): lint+tsc+policy drift -> artifact checks -> unit(+coverage) -> probe -> integration
  -> build-images.sh -> image identity check -> push GHCR + release-manifest.json -> [manual approval]
  -> deploy.sh: pull exact SHA -> one-shot migrator (advisory lock) -> write RCAB_VERSION/RCAB_PREVIOUS_VERSION
     -> up -d --no-deps --wait api web -> reload nginx -> verify-release.sh against the PUBLIC URL
  -> any failure after cutover: rollback.sh --to <previous>, build still FAILS
```

Exit codes of `deploy.sh`: `0` released and verified, `1` failed with auto-rollback disabled, `2` aborted before
cutover (stack untouched), `10` failed and rolled back (previous version verified), `11` failed and rollback failed
(page the owner). `Jenkinsfile.rollback` is a manual job that re-deploys `ROLLBACK_TO` (or the SHA recorded on the
host) and never runs migrations.

**Rollback limits (read before relying on it):** migrations are forward-only and are never reversed; roll back
only across a schema both versions accept, and ship destructive changes as expand, migrate, contract over two
releases. The older images must still exist in GHCR or the VPS cache (never `docker image prune -a`). `compose
down -v` is never run against the live project.

### Environments, config and secrets

| Item | Where |
|---|---|
| Dev | `.env.dev` (auto-created from `.env.dev.example` by `dev:up`) |
| Prod compose interpolation | `/opt/rcab/compose/.env` (`REDIS_PASSWORD`, `RCAB_VERSION`, `RCAB_PREVIOUS_VERSION`, `RCAB_REGISTRY`); `deploy.sh` owns the version lines |
| Prod service env | `/opt/rcab/compose/env/{api,postgres,grafana,backup}.env` (secrets; owner-managed; templates in `infra/docker/env.example/`) |
| Prod secret files | `/opt/rcab/secrets/` (the age **public** recipient `age.key`, others) |
| Web public config | `NEXT_PUBLIC_*` are inlined at **image build time** (Jenkins job env, public values only); the running web container reads none. Changing one means a new web image, i.e. a new release. |
| Business tunables | `docs/POLICY.md` and the generated policy block in `api.env.example`; env vars override per deployment |

The api fails closed at startup outside development/test: weak or missing `JWT_SECRET` (HS256 shared secret, at
least 32 bytes), invalid `CORS_ORIGINS` (must be an explicit https list, no wildcard), missing Firebase Admin
values (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` as one-line JSON in an env var), or an invalid policy
value all abort boot. A failing `migrator` blocks `api` (`service_completed_successfully`).

**Secrets handling is a HITL area.** The authority is
[`80-infrastructure/secrets-management.md`](../../../80-infrastructure/secrets-management.md); you must not change
that note, rotate keys, add a secrets product or alter where secrets live without the owner. Note for the owner (not
edited here): that note describes an RS256 key path, a JWKS endpoint and a `firebase-admin.json` file, while the
code uses an HS256 `JWT_SECRET` env var, has no JWKS endpoint, and reads Firebase credentials from
`FIREBASE_SERVICE_ACCOUNT_JSON`; FCM is not used by the api yet. Reconcile the note and the code deliberately.

### Backups and recovery (summary; the runbook is authoritative)

Nightly 21:00 UTC (02:30 IST) `pg_dump -Fc | age` into `/opt/rcab/backups` with sha256 and manifest, 30 daily + 12
monthly kept, optional rclone offsite (**off by default**). **RPO is up to about 24 h; RTO is not proven on
production-sized data; without offsite a lost disk loses the backups.** The age identity must be held by the owner
off the VPS. Drills: `backup-rehearsal.sh` (monthly in the nightly job), `restore-drill.sh` on a real backup
(monthly, from an operator machine), `redis-loss-drill.sh`. Restore, Redis loss, `migration_conflict` and full-host
loss procedures: [`recovery-runbook.md`](../../operations/recovery-runbook.md).

### Phase-0 scaling limits (ADR-0009)

Designed for about 5,000 users and 100 drivers on one VPS (vault `20-architecture/scaling-strategy.md`, ADR-0009
at `99-decisions/ADR-0009-single-vps-phase-0.md`).

| Constraint | Consequence |
|---|---|
| Single host | The VPS is the single point of failure; accepted 30-minute RTO goal is a target, not a measurement |
| One api node | Socket.IO runs single-node (the Redis adapter is a no-op); gauges like `rcab_ws_connections` are per node |
| OSRM co-located | Budgeted at <= 4 GB RAM (performance budget); couples its memory to everything else. Budgets: api <= 1.5 GB, Redis <= 600 MB, Postgres connections <= 60% of pool |
| Presence in Redis | Redis loss is an availability event, not data loss (rebuild from Postgres) |
| Step-up triggers (two consecutive weeks) | active drivers > 300, completed rides > 10,000/day, API p99 > 800 ms, VPS CPU > 70%, Postgres connections > 70% of pool, Redis > 50k ops/s. Step 1 is vertical (8 vCPU/32 GB, PgBouncer, read replica); splitting the data tier is Phase-1 and needs an ADR. |

---

## 3. Key workflows for this role

Workflow documents are in [`../workflows/`](../workflows/README.md) ([local setup](../workflows/local-setup.md), [release and deploy](../workflows/release-and-deploy.md), [incident and recovery](../workflows/incident-and-recovery.md), [database migrations](../workflows/database-migrations.md), [testing](../workflows/testing.md)), behaviour in
[`../functionality/`](../functionality/), the state machines the system enforces in
[`../state-machines.md`](../state-machines.md). Videos: ops scenes M01 to M06
([`../videos/ops/INDEX.md`](../videos/ops/INDEX.md)).

### 3.1 Cut a release

1. Merge to `main` (PR, review). Jenkins runs the full pipeline; read the red stage, not the last line.
2. After `Push to GHCR`, the pipeline pauses at **Deploy to staging** for a human approval (`DEPLOY_APPROVER` is
   recorded). Before approving anything that targets a real VPS: smoke list ready, secrets present, a verified
   recent backup, and no destructive migration in the diff. This is a **HITL** stop.
3. Watch `deploy.sh` output and then the dashboards for 15 minutes (see the
   [monitoring guide](monitoring-maintenance-dev.md)). Confirm `/v1/health/version` equals the SHA.
4. On exit 10, the system rolled itself back; investigate before retrying. On exit 11, stop and escalate.

Manual deploy or rollback from a laptop: `scripts/deploy/deploy.sh --version <sha> --remote user@host --ssh-key ...
--known-hosts ... --api-url https://... [--sync-infra]` and `scripts/deploy/rollback.sh (--previous | --to <sha>)`;
`--help` lists every option.

### 3.2 Jenkins credentials and the owner's one-time actions

Pipeline code needs these to exist in Jenkins; creating them is the **owner's** action (they are secrets):

| ID | Type | Needed for |
|---|---|---|
| `ghcr-pat` | Secret text | push images (`write:packages`) |
| `vps-ssh-key` | SSH username with private key | deploy over SSH |
| `vps-known-hosts` | Secret file | pinned host key (no trust-on-first-use) |
| `vps-host` | Secret text | `PROD_HOST` |

Job/folder environment: `NEXT_PUBLIC_*` (public values; the web Dockerfile fails the build if a required one is
empty), `PROD_API_URL`, optional `PROD_WEB_URL`. The VPS itself needs one-time `docker login ghcr.io` with a
**read-only** (`read:packages`) token. Jenkins mounts the host Docker socket, which is root-equivalent: keep it on
loopback (it is `127.0.0.1:8080`) and treat its credentials store as production secrets. Create the `rcab-rollback`
Pipeline job from `Jenkinsfile.rollback`, and a separate nightly job from `Jenkinsfile.nightly` on a CI worker that
is **not** the VPS (it needs ports 3000, 3002, 55432, 6379 free and refuses to start otherwise).

### 3.3 Bootstrap a new VPS (outline; no script exists yet)

Based on `scripts/deploy/README.md` "Host layout" and vault `80-infrastructure/vps-topology.md`:

1. Ubuntu 24.04 LTS, static IP, DNS A/AAAA for the app and api hosts, UFW (allow 22 key-only, 80, 443), SSH key-only
   with fail2ban, unattended-upgrades, sysctls (`vm.overcommit_memory=1`, `net.core.somaxconn=4096`, transparent
   hugepages off), non-root `rcab` user in the `docker` group.
2. Create `/opt/rcab/{infra,compose,compose/env,secrets,backups}` with tight modes. Fill `compose/.env` from
   `compose.env.example` and the four `*.env` files from `infra/docker/env.example/` (owner supplies secrets).
3. `docker login ghcr.io` with the read-only token.
4. **Replace the placeholder domain.** The nginx vhosts hard-code `app.rcab.example` / `api.rcab.example` and the
   certificate path `/etc/letsencrypt/live/rcab.example/`. This is not parameterised yet (see tasks).
5. Obtain certificates (webroot challenge on port 80) before nginx can serve TLS. There is no automated issuance or
   renewal today: the `certbot` service in the prod compose is a bare container.
6. Bring up the long-lived services once (`postgres redis osrm certbot ...`; OSRM builds its graph on first start),
   then run the first `deploy.sh`, which starts `api`, `web` and `nginx`.
7. Create the age identity elsewhere and put only the public recipient in `/opt/rcab/secrets/age.key`. Run a first
   backup immediately and a restore drill from an operator machine.
8. Smoke: `scripts/prod-smoke.sh` equivalent against the public URL (`verify-release.sh`), then walk one journey
   (sign in, book, driver accepts). **Deploying to a real VPS is a HITL stop.**

### 3.4 Operate

| Need | How |
|---|---|
| What is running | `docker compose -f /opt/rcab/infra/docker/docker-compose.prod.yml --env-file /opt/rcab/compose/.env ps`; `curl .../v1/health/version` |
| Restart the api (e.g. after Redis loss) | `docker compose ... restart api`; it rebuilds projections ([runbook section 5](../../operations/recovery-runbook.md)) |
| Resource use vs budget | `/docker-stats` skill, `docker stats`, `df -h`, `docker system df` |
| Restore Postgres, full host loss | [runbook sections 4 and 7](../../operations/recovery-runbook.md) |
| Validate compose edits | `/validate-compose`, then `pnpm prod:test` |
| Load test | `pnpm load:prepare && pnpm test:load:workload`, `pnpm test:load` (probe); budgets generated into `infra/load/perf-budget.generated.json` |
| Host capability estimate | `pnpm system:probe` (RCAB-E1.S9) |

---

## 4. Conventions and gotchas

- **Never `docker compose down -v` against a live project**, and never `docker image prune -a` on the VPS (rollback
  needs old images). The dev equivalent (`pnpm dev:down -v`) is fine locally and is the fix for a stale Postgres volume.
- **Digest-pin third-party images** as the existing prod compose does; keep tags readable next to the digest.
  `postgres` and `osrm` are `platform: linux/amd64` (slow under emulation on Apple Silicon).
- **Dev vs prod parity gaps:** dev has no TLS or nginx; dev Redis has no password; dev publishes DB/Redis host ports;
  dev bind-mounts source. Do not conclude prod is fine from dev. `pnpm prod:test` is the parity check.
- **`NODE_ENV=production` changes behaviour:** the refresh cookie gets `Secure`, Firebase credentials become
  mandatory, `JWT_SECRET`/`CORS_ORIGINS` are validated. `prod-up.sh` mints a throwaway RSA key to satisfy
  firebase-admin in CI; it is never valid against Google.
- **nginx limits:** `limit_req_zone ... rate=60r/m` with `burst=20` on `/v1/` is per client IP; a carrier-grade NAT
  full of riders shares one bucket. Measure before tightening; the app also has its own throttler (policy `rateLimits.*`).
  WebSocket location uses 7-day read/send timeouts.
- **`/metrics` is currently reachable through the public API vhost** (`location /` proxies every path). Prometheus
  scrapes `api:3000` internally, so blocking it at nginx is safe (task 2).
- **Observability tools have no external access path** in prod (no ports, no vhost). Document an SSH-tunnel recipe or
  add an authenticated vhost with the owner's approval.
- **Migrations run before cutover**; if one is slow or locks a hot table, deploys block. Keep them small and
  backwards compatible (expand, migrate, contract).
- **OSRM** is stateful: its graph lives in the `osrm-data` volume built from an OSM extract (`OSM_PBF_URL`; dev/pilot
  region NE India). Changing the region means rebuilding the graph and re-checking quote latency.
- **Release path is rehearsed, not proven.** The first real deploy will surface host-specific issues (DNS, certs,
  registry login, disk, firewall). Do it with the owner, with a fresh backup, in a quiet window.
- **Vault vs code:** `ci-cd.md` and `vps-topology.md` were corrected to match the shipped pipeline and layout;
  `ssl-letsencrypt.md` carries an implementation-status note because issuance and renewal are not built. Trust the
  compose files and Jenkinsfiles first.
- **Commits:** `<type>(infra|ci): <subject>` with a `Story:` trailer; run `/validate-compose` for compose edits and
  update the matching vault note in the same change.

---

## 5. Quality gates

| Gate | Command |
|---|---|
| Compose files parse | `/validate-compose` |
| Pipeline-equivalent checks | `pnpm lint`, `pnpm policy:doc:check`, `pnpm -r exec tsc --noEmit`, `pnpm --filter @rcab/api run test:artifact`, `test:dev-loader`, `test:cov`, `pnpm test:probe`, `pnpm system:probe --ci` |
| Integration | `pnpm test:int` |
| Prod-like boot and smoke | `pnpm prod:test` |
| Release and rollback | `bash scripts/deploy/rehearse-local.sh` |
| Recovery | `scripts/recovery/backup-rehearsal.sh`, `redis-loss-drill.sh`, monthly `restore-drill.sh` on a real backup |
| Load | `pnpm test:load`, `pnpm test:load:workload` (budget gates from policy `perfBudget.*`) |
| Security | `/security-scan` (npm audit, secret scan, OWASP patterns) mapped against `90-quality/security-checklist.md` |
| Story gate | `pnpm verify` |

---

## 6. Escalate (HITL) before you act

Straight from [`95-delivery/hitl-touchpoints.md`](../../../95-delivery/hitl-touchpoints.md) and `CLAUDE.md`:

- **Deploying to a real VPS** (any demo >= 7): smoke list, secrets present, backup verified.
- **Anything touching secrets handling or the `secrets-management` note**, key rotation, creating Jenkins credentials.
- **Installing a system-level package** on a developer machine or host (brew, apt, corepack switches).
- **Adding an external service with cost or lock-in** (registry other than GHCR, DNS or CDN, managed database,
  pager, hosted monitoring, offsite storage vendor).
- **Anything toward multi-host or Kubernetes** (ADR-0009). Creating or superseding an ADR is itself a stop.
- **Accepting the backup RPO/RTO** and **enabling offsite**: business decisions with cost.
- **A flaky pipeline stage you want to quarantine.**
- Changing a story's acceptance criteria, reordering epics, bumping a demo headline.

---

## 7. First 5 good tasks (from real open gaps)

1. **TLS end to end (RCAB-E8.S6).** Parameterise the domain in the nginx vhosts, document and automate first
   issuance, add a scheduled `certbot renew` plus nginx reload, add HSTS and a CSP, set a certificate-expiry
   alert, and prove it with the self-signed `prod:test` plus one real-domain rehearsal. Also fix the "systemd timer /
   `--nginx` plugin" mismatch noted in `ssl-letsencrypt.md`.
2. **Close the public `/metrics` and give operators a way in.** Deny `/metrics` (and nothing else under `/`) at the
   API vhost, then write and test the access path to Grafana/Prometheus/Kuma in production. Coordinate with the
   monitoring owner, who also wants Redis and Postgres exporters in the prod compose (RCAB-E8.S1).
3. **Make the VPS bootstrap repeatable.** Turn section 3.3 into a script or runbook that is rehearsed on a scratch
   VM: users, firewall, sysctls, directory layout and modes, env templates, GHCR read token, first bring-up order.
   The first real deploy is HITL, so deliver the rehearsal first.
4. **Confirm the Phase-0 performance budget on the target VPS class (RCAB-E8.S5).** Run the realistic k6 workload
   against a prod-like deployment on hardware matching the intended VPS, record p50/p95/p99, memory (api, Redis,
   OSRM) and Postgres connection use against the budgets, and write the result into the vault performance note.
5. **Backup custody and offsite (RCAB-E8.S3 follow-ups).** With the owner: decide the offsite target and RPO,
   enable offsite via `backup.env`, run the first monthly `restore-drill.sh` on a real backup, record RTO in the
   runbook table, and wire a backup-freshness signal for alerting (shared with the monitoring owner).

Also worth doing: add a Flutter analyze/test stage for the driver app to Jenkins, review the Jenkins docker-socket
risk, add `pnpm code:graph:check` to a Jenkins stage, and publish the driver APK build/signing
process (currently only `apps/driver-app/SETUP.md` describes local builds).

---

## 8. References

| Topic | Where |
|---|---|
| Orientation | [`CLAUDE.md`](../../../CLAUDE.md), [`00-index/HOME.md`](../../../00-index/HOME.md), [`00-index/reading-paths.md`](../../../00-index/reading-paths.md) |
| Release scripts, host layout, rollback limits | [`scripts/deploy/README.md`](../../../scripts/deploy/README.md) |
| Backups, drills, restore, conflicts | [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md) |
| Architecture and ports | [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| Business tunables and env vars | [`docs/POLICY.md`](../../POLICY.md) |
| Bring-up and demo hand-walks | [`docs/manual-testing/RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md) |
| Stage C contract (what Redis/Postgres each own) | [`docs/remediation/stage-c-contract.md`](../../remediation/stage-c-contract.md) |
| Infra vault notes | `80-infrastructure/` (`docker-compose`, `ci-cd`, `vps-topology`, `nginx-reverse-proxy`, `ssl-letsencrypt`, `backups`, `observability`, `secrets-management`: HITL) |
| Decisions | `99-decisions/ADR-0009-single-vps-phase-0.md`, `20-architecture/scaling-strategy.md`, `deployment-topology.md` |
| Quality | `90-quality/performance-budget.md`, `security-checklist.md`, `testing-strategy.md`, `local-system-probe.md` |
| Pipelines | `Jenkinsfile`, `Jenkinsfile.nightly`, `Jenkinsfile.rollback` |
| Skills | `/smoke-check`, `/validate-compose`, `/env-validate`, `/docker-stats`, `/k6-load`, `/security-scan`, `/osrm-check`, `/db-migrate` |
| Sibling guides | [`backend-dev.md`](backend-dev.md), [`monitoring-maintenance-dev.md`](monitoring-maintenance-dev.md) |
