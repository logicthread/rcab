---
title: RCAB-E1.S4 — Production compose (docker-compose.prod + nginx + Let's Encrypt)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: m
hitl: yes
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[docker-compose]], [[nginx-reverse-proxy]], [[ssl-letsencrypt]], [[vps-topology]], [[secrets-management]]
owner: claude
audience: both
---

# RCAB-E1.S4 — Production compose (docker-compose.prod + nginx + Let's Encrypt)

## Goal

A single `docker-compose.prod.yml` brings up the entire production stack on a single VPS: nginx + TLS, api, postgres, redis, osrm, plus the observability stack. Web static export is served by nginx. Migrations run as a one-shot dependency. All secrets come from env files outside the repo.

## User-facing acceptance criteria

- `Given` a freshly provisioned VPS (Ubuntu 24.04, Docker installed), `When` I clone the repo, drop env files into `/opt/rcab/compose/env/`, and run `docker compose -f docker-compose.prod.yml up -d`, `Then` `https://api.rcab.example/v1/health/ready` returns 200 within 90 seconds.
- `Given` the prod stack is up, `When` certbot's renewal hook fires, `Then` nginx reloads without dropping a single WS connection.

## Technical acceptance criteria

- All containers on a private `rcab_net`; only nginx publishes ports 80/443.
- nginx config from [[nginx-reverse-proxy]] (WebSocket upgrade, rate limits, HSTS).
- `migrator` service is one-shot (`restart: 'no'`); `api` depends on its successful completion.
- Image tags are pinned by SHA (no `:latest`).
- `restart: unless-stopped` on long-running services.
- Backup sidecar from [[backups]] included.

## HITL stops

- Before first deploy to a real VPS: developer reviews the compose file, confirms domain DNS, confirms certbot email, and runs the smoke check ([[hitl-touchpoints]]).

## Test plan

- Smoke: a CI job that brings up the prod compose locally in a kind-of-prod mode (with self-signed certs) and runs the readiness check.
- Manual: documented walk-through in `README.md` for the first VPS bring-up.

## Out of scope

- Multi-region.
- Kubernetes anything.

## See also
- [[epic-e1-foundation]] · [[docker-compose]] · [[nginx-reverse-proxy]] · [[ssl-letsencrypt]] · [[vps-topology]]
