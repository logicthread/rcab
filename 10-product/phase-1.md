---
title: Phase-1 scope
tags: [layer/product, kind/moc]
status: proposed
phase: 1
depends_on: [[phase-0]]
related: [[scaling-strategy]]
audience: both
---

# Phase-1 — Scale & multi-platform

*Triggered when any of: clients > 20k, drivers > 500, second city, or VPS sustained CPU > 70%.*

## Likely changes

- **Move Postgres** to a managed instance (Aurora / RDS / equivalent), reads via PgBouncer.
- **Adopt MongoDB** for event-style data (location history, ride traces, ratings before aggregation). Keep transactional state in Postgres.
- **Split realtime tier** — separate node for Socket.IO with Redis adapter.
- **Native clients** for both rider (React Native, sharing logic with the Next.js codebase) and iOS driver (Flutter already cross-platform).
- **In-app payments** (Razorpay/UPI).
- **Multi-city operations** — geographic sharding of dispatch indexes.
- **A/B testing** infrastructure for matching algorithms.
- **Surge / dynamic pricing.**
- **CDC pipeline** from Postgres → MongoDB → analytics warehouse.

## See also
- [[phase-0]] · [[scaling-strategy]] · [[deployment-topology]]
