---
title: RCAB-E1.S5 — CI/CD pipeline (Jenkins in docker-compose)
tags: [layer/delivery, kind/story]
status: in_progress
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

# RCAB-E1.S5 — CI/CD pipeline (Jenkins in docker-compose)

## Goal

Every push gets linted and tested. Every merge to `main` builds container images and (on a manual gate) deploys to a staging VPS. Jenkins runs as a service in the existing docker-compose stack; GitHub is a plain git remote.

## User-facing acceptance criteria

- `Given` a push or PR, `When` Jenkins runs the pipeline, `Then` `lint`, `test:unit`, `test:int`, `build` stages all pass (or the pipeline is marked failed).
- `Given` a merge to `main`, `When` the deploy stage is approved via the Jenkins `input` gate, `Then` the staging VPS is updated and `/v1/health/ready` returns 200 within 90 seconds.

## Technical acceptance criteria

- `Jenkinsfile` at repo root: declarative pipeline with stages — Install → Lint → Unit tests → Integration tests → Build images → Push to GHCR (main/release only) → Deploy to staging (main/release, `input` gate).
- `Jenkinsfile.nightly`: cron `H 2 * * *`, runs `test:e2e` and `test:load`; failures echo a stub message (Linear integration deferred).
- `infra/docker/jenkins/Dockerfile`: `jenkins/jenkins:lts-jdk21` base + Docker CLI + Node 20 + pnpm 10.
- Jenkins service added to `docker-compose.prod.yml`, bound to `127.0.0.1:8080`, Docker socket mounted.
- Build matrix: `apps/api` and `apps/web` Docker images; `apps/driver-app` deferred to a dedicated agent (Flutter build is not in the Jenkins container).
- Jenkins credentials to configure: `ghcr-pat`, `vps-host`, `vps-ssh-key`.

## Test plan

- Self-tested: pipeline running green against a test push to the repo.

## Out of scope

- Promotion from staging to prod (manual gate for Phase-0; automate later).
- Jenkins GitHub plugin / commit status reporting to GitHub.
- Flutter build in Jenkins (needs separate Flutter-capable agent).

## See also
- [[epic-e1-foundation]] · [[ci-cd]] · [[testing-strategy]]
