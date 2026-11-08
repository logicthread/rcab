# scripts/deploy — immutable release, verified deploy, rollback (RCAB-E8.S11)

| Script | Runs where | Does |
|---|---|---|
| `build-images.sh --version <sha>` | CI / laptop | Builds `rcab-api:<sha>` and `rcab-web:<sha>` once (build identity baked in). Never pushes. |
| `deploy.sh --version <sha> --remote u@h --api-url https://…` | CI / laptop | Records previous, ships `infra/`, host `apply` over SSH, `verify-release.sh`, auto-rollback on failure. |
| `rollback.sh (--previous \| --to <sha>) …` | CI / laptop | Re-deploys an earlier release (no migrations) and verifies it. |
| `verify-release.sh --api-url … --expect-version <sha>` | anywhere | Polls `/v1/health/ready` + `/v1/health/version` (+ web `/version.json`); wrong version = failure. |
| `rehearse-local.sh` | laptop | Full release/rollback scenario against a throwaway local compose project (no SSH). |

`deploy.sh --help` lists every option. Host layer is the same file piped to `bash -s` over SSH, so the
VPS needs no checkout.

## Release identity

- Image tag = commit SHA; also `org.opencontainers.image.revision` label and `RCAB_VERSION` build arg.
- API: `GET /v1/health/version` -> `{"version":"<sha>","builtAt":"…"}`. Web: `GET /version.json` (same shape).
- `docker-compose.prod.yml` runs `${RCAB_REGISTRY:-ghcr.io/logicthread}/rcab-{api,web}:${RCAB_VERSION}`; `RCAB_VERSION`
  has no default. `deploy.sh` owns `RCAB_VERSION` / `RCAB_PREVIOUS_VERSION` in `/opt/rcab/compose/.env`.
- Local prod-test (`pnpm prod:test`) builds the same tags from source via `docker-compose.prod-test.yml`.

## Host layout (VPS bootstrap)

```
/opt/rcab/infra/{docker,observability}/   written by deploy.sh --sync-infra (do not hand-edit)
/opt/rcab/compose/.env                    REDIS_PASSWORD, RCAB_VERSION, RCAB_REGISTRY …  (compose.env.example)
/opt/rcab/compose/env/*.env               api/postgres/grafana/backup env files (secrets; owner-managed)
/opt/rcab/secrets, /opt/rcab/backups
```
One-time: `docker login ghcr.io` on the VPS with a read-only (`read:packages`) token; bring up the long-lived
services once (`postgres redis osrm certbot …`); the first `deploy.sh` starts api/web/nginx.

## What a release does

1. `compose pull api web` at the exact SHA (fails => stack untouched).
2. One-shot `migrator` (`node dist/migrate.js`, Postgres advisory lock) (fails => stack untouched).
3. Write `RCAB_VERSION=<sha>` / `RCAB_PREVIOUS_VERSION=<old>`; `up -d --no-deps --wait api web`; reload nginx.
4. `verify-release.sh` against the **public** URL (real TLS/DNS): ready + version == SHA.
5. Any failure after cutover => `rollback.sh --to <previous>`; the run still exits non-zero.

Exit codes: `0` ok · `1` failed (auto-rollback disabled) · `2` aborted before cutover · `10` failed and rolled
back (verified) · `11` failed and rollback failed.

## Rollback limits (read before relying on it)

- Migrations are forward-only and are not reversed or re-run on rollback. Roll back only across a schema both
  versions accept; ship destructive migrations (drop/rename column) as expand -> migrate -> contract over 2 releases.
- The older images must still be in GHCR or in the VPS's local cache (do not `docker image prune -a`).
- `compose down -v` is never used against the live project.
