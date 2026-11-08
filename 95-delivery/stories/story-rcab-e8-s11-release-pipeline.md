---
title: RCAB-E8.S11 — Release pipeline: immutable images, verified deploy, rollback
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S11
demo: 7
estimate: l
hitl: yes
depends_on: [[story-rcab-e8-s8-review-remediation-stage-c]]
blocks:
affected_notes: [[ci-cd]], [[docker-compose]], [[vps-topology]], [[nginx-reverse-proxy]]
owner: both
audience: both
---

# RCAB-E8.S11 — Release pipeline: immutable images, verified deploy, rollback

## Goal

Review finding F14 (guide R11): the checked-in pipeline published images to GHCR that the production Compose file never used (`build:` on the VPS), "deployed" with `docker compose pull && up -d` (which changes nothing about the running source), smoke-tested `localhost` on the Jenkins executor instead of the VPS, and the nightly job expected a stack nobody started. This story makes a release a single immutable artifact: build API and web once per commit, tag them with the commit SHA, deploy exactly that tag, prove over the real network that the running build reports that SHA, and be able to go back.

Scope is the release mechanism only. It does not change business behaviour, the policy config being refactored on another branch, secrets handling, or the VPS topology (Phase-0: one VPS, one compose project, ADR-0009).

## User-facing acceptance criteria

- Given a commit on `main`/`release/*`, When the pipeline runs, Then API and web images tagged with that full SHA (and no mutable `latest`) are built once, label-checked, pushed, and a manifest with their registry digests is archived.
- Given an approved deploy, When it completes, Then `GET <public api>/v1/health/version` and `<public web>/version.json` report the deployed SHA, and the stage is green only because that was observed on the real target.
- Given a release whose smoke check fails (not ready, or wrong version), When verification times out, Then the previous SHA is redeployed automatically, verified, and the pipeline run still FAILS with a distinct exit code (a rolled-back release is never a green build).
- Given an operator, When they run the rollback job (or `scripts/deploy/rollback.sh --previous|--to <sha>`), Then the earlier release is restored and verified without running or reversing migrations.
- Given the nightly job, When it starts, Then it brings up its own compose project, migrates, seeds, waits for readiness, runs e2e + load, archives diagnostics, and always tears the project down.

## Technical acceptance criteria

- `GET /v1/health/version` returns `{version, builtAt}` from the `RCAB_VERSION` / `RCAB_BUILT_AT` build args; web serves `/version.json` written at image build; both images carry `org.opencontainers.image.revision`.
- `docker-compose.prod.yml`: api, web and migrator use `${RCAB_REGISTRY:-ghcr.io/logicthread}/rcab-{api,web}:${RCAB_VERSION:?}`; no `build:` for them. `docker-compose.prod-test.yml` builds the same tags, so `pnpm prod:test` still works.
- Migrator runs as an explicit one-shot from the production api image (compiled `dist/migrate.js`, no `tsx`), serialised by a Postgres advisory lock.
- `scripts/deploy/{deploy,rollback,verify-release,build-images}.sh` run outside Jenkins; deploy records `RCAB_PREVIOUS_VERSION` on the host; SSH uses `StrictHostKeyChecking=yes` with a pinned known_hosts.
- `scripts/prod-smoke.sh` has no default target and requires an expected version; `deploy.sh --remote` refuses loopback verification URLs.
- `.dockerignore` keeps host `node_modules`, the vault and VCS state out of the build context.

## Test plan

- Unit: `health-version.spec.ts` (build-arg env -> response, dev fallback).
- Local rehearsal (`scripts/deploy/rehearse-local.sh`, throwaway compose project `rcab-sim`): deploy test1 -> deploy test2 -> version assertion fails when the wrong version runs -> rollback to test1 -> bad release auto-rolls back (exit 10) -> missing image aborts before cutover (exit 2).
- `docker compose config` for dev, prod, prod+prod-test, prod+prod-test+sim; both images built with a test SHA.
- Not testable here: a real Jenkins run, GHCR push, SSH to a VPS, public TLS/DNS. See HITL stops.

## HITL stops

- This story touches deployment and CI/CD. The first real deploy (any demo >= 7 VPS deploy) needs developer sign-off.
- Jenkins credentials, VPS bootstrap and DNS are owner actions (below); nothing here deploys, SSHes, or pushes images.

## Out of scope

- Digest-pinned deploy (the manifest records digests; compose still pulls by SHA tag), image signing/SBOM.
- Authenticated representative-flow smoke (needs Firebase test project; tracked with R12/R13).
- Browser-config smoke on the deployed bundle (F13 verification in staging).
- Staging vs production environment split; blue/green. Phase-0 is one VPS.
- Automatic data-migration rollback. Schema compatibility across versions is a release-author responsibility.

## Notes / questions

- Nightly uses the dev compose (fixed host ports); it must run on a CI worker, not the live VPS. The job refuses to start if those ports are taken.
- Owner decisions needed: where Jenkins nightly runs, GHCR visibility, whether staging and production get separate web images (NEXT_PUBLIC_* differ).

## See also

- [[epic-e8-production-hardening]] · [[story-rcab-e8-s8-review-remediation-stage-c]]
- [[ci-cd]] · [[docker-compose]] · [[vps-topology]] · [[nginx-reverse-proxy]]
- `scripts/deploy/README.md` · [[story-template]] · [[hitl-touchpoints]] · [[impact-analysis]]
