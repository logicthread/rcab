---
title: docker-compose layout
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[vps-topology]]
related: [[nginx-reverse-proxy]], [[migrations]], [[observability]]
audience: both
---

# docker-compose layout

*One compose file describes the whole runtime.*

## Services

| Service | Image | Notes |
|---|---|---|
| `nginx` | `nginx:alpine` | Reverse proxy; mounts certs from `/opt/rcab/certs/`. Hosts the Next.js static export. |
| `api` | `rcab/api:<ref>` | NestJS process. Depends on `postgres`, `redis`, `osrm`, `migrator` |
| `migrator` | `rcab/api:<ref>` | One-shot — runs `pnpm migrate up` then exits. `api` waits on its completion |
| `postgres` | `postgis/postgis:16-3.4` | PostGIS-enabled. Health check via `pg_isready` |
| `redis` | `redis:7-alpine` | AOF on. Volume mounted |
| `osrm` | `osrm/osrm-backend:latest` | India PBF preprocessed offline; runs `osrm-routed --algorithm mld` |
| `backup` | `rcab/backup:latest` | Cron container; nightly `pg_dump` to off-host storage |
| `loki` | `grafana/loki:latest` | Log aggregation |
| `promtail` | `grafana/promtail:latest` | Ships docker logs to Loki |
| `prometheus` | `prom/prometheus` | Metrics scraping |
| `grafana` | `grafana/grafana` | Dashboards |

## Networks

- One internal network `rcab_net` — all services attach.
- Only `nginx` publishes ports (`80`, `443`).

## Volumes

- `pg-data`, `redis-data`, `osrm-data`, `loki-data`, `prom-data`, `grafana-data` — named volumes.
- Backed up via the `backup` service to off-host object storage. See [[backups]].

## Restart policy

- `restart: unless-stopped` for everything except `migrator` (`restart: "no"`).

## Environment

- Each service reads from its own `*.env` file under `/opt/rcab/compose/env/`. See [[secrets-management]].

## CI handoff

- CI builds images, pushes to a private registry, and runs `docker compose pull && docker compose up -d` on the VPS via SSH. See [[ci-cd]].

## See also
- [[vps-topology]] · [[nginx-reverse-proxy]] · [[migrations]]
- [[secrets-management]] · [[backups]] · [[observability]] · [[ci-cd]]
