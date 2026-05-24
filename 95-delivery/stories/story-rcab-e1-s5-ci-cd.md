---
title: RCAB-E1.S5 — CI/CD pipeline (GitHub Actions)
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: m
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[ci-cd]], [[testing-strategy]], [[secrets-management]]
owner: claude
audience: both
---

# RCAB-E1.S5 — CI/CD pipeline (GitHub Actions)

## Goal

Every push gets linted and tested. Every merge to `main` builds container images and (on a manual gate) deploys to a staging VPS. The pipeline is the same artifact path that production will use.

## User-facing acceptance criteria

- `Given` a PR, `When` checks run, `Then` `lint`, `test:unit`, `test:int`, `build` are all green (or the PR is blocked from merging).
- `Given` a merge to `main`, `When` the deploy job is approved by a maintainer, `Then` the staging VPS is updated and `/v1/health/ready` returns 200 within 90 seconds of the deploy job's completion.

## Technical acceptance criteria

- `.github/workflows/ci.yml` runs on every PR: lint, unit, integration (with Postgres + Redis services), build images (no push).
- `.github/workflows/deploy.yml` runs on push to `main` and `release/*`: pushes images to `ghcr.io/rcab/*`, then a gated `deploy-staging` job SSHes (or uses GitHub OIDC → ssh action) to the VPS and runs `docker compose pull && up -d`.
- Required PR checks: `lint`, `test:unit`, `test:int`, `build`.
- A nightly cron workflow runs `test:e2e` and `test:load` against staging; failures open a Linear issue but don't block merges.
- Build matrix: `apps/api`, `apps/web`, `apps/driver-app` (debug APK as artifact only).
- Branch protection on `main`: PR required, status checks required, one review.

## Test plan

- Self-tested: the pipeline running green on its own bootstrap PR.

## Out of scope

- Promotion from staging to prod (manual gate for Phase-0; automate later).
- Helm / Kubernetes / Argo anything.

## See also
- [[epic-e1-foundation]] · [[ci-cd]] · [[testing-strategy]]
