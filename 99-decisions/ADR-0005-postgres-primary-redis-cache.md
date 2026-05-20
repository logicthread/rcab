---
title: ADR-0005 — Postgres as system of record; Redis for fast-path / ephemeral
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[database-choice]], [[schema-postgres]], [[redis-usage]]
audience: both
---

# ADR-0005 — Postgres as system of record; Redis for fast-path / ephemeral

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

We have transactional data (users, rides, ratings) and ephemeral / latency-critical state (driver positions, dispatch offer locks, scheduled jobs, WS pub/sub). Putting both into one store is uneconomical; choosing the right combination is.

## Decision

- **Postgres 16** (with PostGIS) as the single system of record. All transactional state lives here.
- **Redis 7** for: driver GEO index, dispatch offer locking, BullMQ scheduled jobs, Socket.IO Redis adapter, hot read caches.
- **MongoDB is deferred** to Phase-1 if/when we have a clear append-only high-volume need (e.g., per-ride location traces beyond what we already persist for active rides).

## Consequences

- Positive
  - One transactional DB, simple to reason about and back up.
  - Redis takes the hot dispatch path off Postgres.
  - PostGIS gives us geographies for free, so the user-visible model doesn't have to be split awkwardly.
- Negative
  - Two operational components instead of one.
  - State-dual: driver availability exists in both Redis (authoritative for dispatch) and Postgres (denormalized). Discipline required.
- Neutral
  - We can add MongoDB or a time-series DB later without redesigning the core.

## Alternatives considered

- **MongoDB primary** — flexible, but transactions and geo joins are weaker; we'd be writing more glue.
- **Postgres + ElasticSearch** — Elastic for geo is overkill at our scale.
- **Postgres only** — feasible at 100 drivers, but the geo + dispatch hot path doesn't belong on the OLTP DB even at small scale.

## See also
- [[database-choice]] · [[schema-postgres]] · [[redis-usage]]
- [[scaling-strategy]]
