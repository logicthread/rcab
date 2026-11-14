# Workflow: release and deploy

Phase-0 topology (ADR-0009): **one VPS, one docker-compose** (`infra/docker/docker-compose.prod.yml`). If a release
idea needs a second host, Kubernetes or a managed cloud service, stop: that is an impact-analysis trigger, not a
detail. **Deploying to a real VPS is a HITL stop** (`95-delivery/hitl-touchpoints.md`): smoke list, secrets present,
backup verified, and an owner who said yes.

Authoritative reference: [`scripts/deploy/README.md`](../../../scripts/deploy/README.md) (release identity, host
layout, what a release does, exit codes, rollback limits). Pipelines: [`Jenkinsfile`](../../../Jenkinsfile),
[`Jenkinsfile.nightly`](../../../Jenkinsfile.nightly), [`Jenkinsfile.rollback`](../../../Jenkinsfile.rollback). Vault:
`80-infrastructure/ci-cd.md`, `docker-compose.md`, `vps-topology.md`, `nginx-reverse-proxy.md`,
`ssl-letsencrypt.md`. Failure handling afterwards: [incident-and-recovery.md](incident-and-recovery.md).

## 1. The model in one paragraph

A release is **one commit SHA**. CI builds `rcab-api:<sha>` and `rcab-web:<sha>` once (nothing is built on the VPS),
bakes the SHA into the image (OCI revision label, `RCAB_VERSION`, `/v1/health/version`, `/version.json`), pushes to
GHCR, and — after a human approves — `scripts/deploy/deploy.sh` ships `infra/`, pulls those exact images on the
VPS, runs the one-shot advisory-locked **migrator**, switches `api` and `web` with `up -d --no-deps --wait`, reloads
nginx, then verifies the **public** URL reports `ready` and `version == <sha>`. Any failure after cutover rolls back
to the previously recorded SHA automatically, and the pipeline stage **still fails** (a rolled-back release is not a
green build).

## 2. Pipeline stages (`Jenkinsfile`)

| Stage | What it proves | Gate |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | |
| Lint | `pnpm lint`, `pnpm policy:doc:check` (generated policy docs in sync), build `@rcab/shared` + `api-client`, `tsc --noEmit` for every package | |
| API artifact | production build ships the Lua assets and the compiled services can read them; the dev loader injects them | |
| Unit tests | api with the coverage floor, web, host probe | |
| System probe smoke | the probe runs on the agent | |
| Integration tests | Testcontainers suites ([testing.md](testing.md)) | |
| Build images | `scripts/deploy/build-images.sh --version $GIT_COMMIT` (no mutable `latest`) | |
| Image identity check | label == SHA; the api process reports it; web `version.json` contains it | |
| Push to GHCR | writes and archives `release-manifest.json` (digests) | only `main` and `release/*` |
| Deploy to staging | `deploy.sh` over SSH with a pinned host key; interactive approval records `DEPLOY_APPROVER` | only `main` and `release/*`; **HITL** |

Nightly (`Jenkinsfile.nightly`): start the stack, Playwright e2e, k6 load, and on the 1st of the month the
backup + restore rehearsal. Manual rollback job (`Jenkinsfile.rollback`): approval prompt, then
`rollback.sh` to `ROLLBACK_TO` (blank = the version the last deploy recorded on the host).

Credentials the pipeline needs (Jenkins credential ids): `vps-ssh-key`, `vps-known-hosts`, `vps-host`, `ghcr-pat`;
plus public `NEXT_PUBLIC_*` values as job environment (they are inlined into the web build; the web Dockerfile
fails the build if a required one is empty). Handling of these secrets is a HITL area.

## 3. Scripts (`scripts/deploy/`)

| Script | Use |
|---|---|
| `build-images.sh --version <sha> [--registry …]` | Build both images once; never pushes |
| `deploy.sh --version <sha> --remote user@host --api-url https://… [--sync-infra]` | Controller + host layer; `--help` lists everything |
| `rollback.sh (--previous \| --to <sha>) …` | Re-deploy an earlier release without migrations; verifies it |
| `verify-release.sh --api-url … --expect-version <sha>` | Poll `/v1/health/ready` + `/v1/health/version` (+ web `/version.json`) |
| `rehearse-local.sh` | Whole release + rollback scenario on a throwaway local compose project (no SSH). **Run it when you change any of the above** |

Exit codes of `deploy.sh`: `0` released and verified · `1` failed, auto-rollback disabled · `2` aborted before
cutover, stack untouched · `10` failed and rolled back, previous version verified · `11` failed **and** rollback
failed (page the owner).

## 4. Local production rehearsal

Before any real deploy, and after changing compose/nginx/Dockerfiles:

```bash
pnpm prod:test          # prod:up (builds prodtest images, self-signed TLS) -> prod:smoke -> obs:smoke -> prod:down
pnpm prod:up            # keep it running to poke at it; pnpm prod:smoke ; pnpm prod:down
/validate-compose       # all compose combinations still parse
```

`docker-compose.prod-test.yml` overlays the prod file to build from source with `RCAB_VERSION=prodtest`.

**First start on a fresh host (or volume):** the `osrm-prep` / `osrm-extract` one-shots download the OSM extract
(`OSM_PBF_URL`, default north-east India) and build the routing graph before `osrm` and the `api` start; this takes
several minutes once and is skipped afterwards. `pnpm prod:test` rebuilds it every run (it uses fresh volumes).

## 5. Release checklist

Before the approval prompt:

1. `main` is green; `pnpm verify` was green on the merged commit; the story/demo is signed off if it is a demo release.
2. **Migrations:** list the new files since the last release. Are they additive and readable by the *previous*
   release (rollback runs old images on the new schema)? Rehearsed on a copy
   ([database-migrations.md](database-migrations.md))? Any destructive statement approved?
3. **Config:** any new policy knob or env var? Is it in the VPS env files (`/opt/rcab/compose/env/*.env`) — an
   invalid value makes the api refuse to boot, the health check fail and the deploy roll back
   ([business-config-changes.md](business-config-changes.md))?
4. **Backup:** a recent successful backup exists (`/opt/rcab/backups/.last_success`); for a data-rewriting migration
   take one now (`docker compose exec backup /usr/local/bin/backup.sh`).
5. **Driver app:** the API must keep working with the previous Android build; a driver-app release is separate
   (`flutter build apk --release --dart-define=API_BASE_URL=https://api…`).
6. Disk space and the previous images still present (do not `docker image prune -a` on the host).

After deploy:

7. `verify-release.sh` passed in the pipeline (public URL, real TLS, version == SHA).
8. Run one full journey by hand ([RUN-GUIDE](../../manual-testing/RUN-GUIDE.md)); watch Grafana overview + dispatch
   dashboards and `rcab_outbox_*` for 15 minutes; check Uptime Kuma is green.
9. Note the SHA and the previous SHA (`RCAB_PREVIOUS_VERSION` on the host is the rollback target).

## 6. Rollback

- Automatic: `deploy.sh` already did it if verification failed (exit 10).
- Manual: run the `rcab-rollback` Jenkins job, or `bash scripts/deploy/rollback.sh --previous --remote … --api-url …`.
- **Limits (read before relying on it):** migrations are forward-only and are not reversed; roll back only across a
  schema both versions accept; destructive changes ship as expand -> migrate -> contract over two releases; the old
  images must still exist in GHCR or the host cache; `compose down -v` is never used on the live project.
- If the problem is data, not code, rolling back images does not help: see [incident-and-recovery.md](incident-and-recovery.md).

## 7. Host layout reminder

```
/opt/rcab/infra/{docker,observability}/   written by deploy.sh --sync-infra (do not hand-edit)
/opt/rcab/compose/.env                    REDIS_PASSWORD, RCAB_VERSION, RCAB_REGISTRY, …
/opt/rcab/compose/env/*.env               api / postgres / grafana / backup env files (secrets; owner-managed)
/opt/rcab/secrets, /opt/rcab/backups
```

Long-lived services (postgres, redis, osrm, certbot, observability, backup) are brought up once; a release only
touches `api`, `web` and nginx.
