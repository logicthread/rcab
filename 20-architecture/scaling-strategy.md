---
title: Scaling strategy
tags: [layer/architecture]
status: accepted
phase: both
depends_on: [[deployment-topology]]
related: [[phase-1]], [[service-boundaries]]
audience: both
---

# Scaling strategy

*A staircase, not a cliff.*

## When to step up

We move when **any** of these are true for two consecutive weeks:

| Signal | Threshold |
|---|---|
| Active drivers | > 300 |
| Daily completed rides | > 10,000 |
| API p99 latency | > 800 ms |
| VPS sustained CPU | > 70% |
| Postgres connections (saturation) | > 70% of pool |
| Redis ops/sec | > 50k |

## Steps

### Step 1 — vertical (still single VPS)

- Bump VPS to 8 vCPU / 32 GB RAM.
- Postgres `shared_buffers` + connection pool tuning.
- Add **PgBouncer** in transaction-pooling mode.
- Add **read replica** for Postgres (logical replication on the same host, then move it to its own VPS).

### Step 2 — split data tier

- Move Postgres to its own VPS (or managed Postgres).
- Move Redis to its own VPS.
- API stays on the original VPS.

### Step 3 — horizontal API

- Run **N API replicas** behind the same nginx (or upgrade to HAProxy/Envoy).
- Socket.IO uses Redis adapter (already configured — see [[module-realtime]]) so multi-node WebSockets just work.
- Add session affinity at the LB so a given driver's WS stays on one node where possible.

### Step 4 — split the monolith

- Extract `dispatch + matching + geo + shared` into its own service. Same repo, separate process. Communicates with the main API via internal RPC (gRPC or HTTP+JSON over private network) plus Redis pub/sub.
- Extract `realtime` to its own process if WebSocket connection counts justify it.

### Step 5 — adopt MongoDB / event log

- Move ride traces (location history per ride), rating raw data, and notification logs to MongoDB.
- Postgres remains the system of record for transactional state.
- A CDC pipeline (Debezium → Kafka → consumers) bridges the two.

## What we do *not* do prematurely

- Microservices for the sake of microservices.
- Kafka before there is a second consumer of any event.
- Kubernetes before there are at least 3 services and 2 environments.

## See also
- [[deployment-topology]] · [[service-boundaries]] · [[phase-1]]
