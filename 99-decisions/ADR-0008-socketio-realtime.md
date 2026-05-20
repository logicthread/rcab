---
title: ADR-0008 — Socket.IO for realtime
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[module-realtime]], [[websocket-events]], [[redis-usage]]
audience: both
---

# ADR-0008 — Socket.IO (with Redis adapter) for realtime

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

We need bidirectional realtime events for ride offers, state changes, and location updates. The transport must work over flaky 3G, support reconnects, and survive horizontal scaling later.

## Decision

Use **Socket.IO 4** in NestJS with the **Redis adapter from day one**. Even on a single Node process the adapter is enabled — adds negligible overhead and lets Phase-1 split realtime across nodes with zero protocol change.

## Consequences

- Positive
  - Robust reconnect, room semantics, fallbacks.
  - NestJS has first-class gateway support.
  - Redis adapter is the standard scale-out path.
- Negative
  - Slightly heavier than raw WebSocket.
  - Older Socket.IO clients can leak — we lock to v4 across clients.
- Neutral
  - Driver app uses `socket_io_client` (Dart) which tracks v4.

## Alternatives considered

- **Raw WebSocket** — leaner but we'd reimplement room semantics, reconnect, and fallbacks.
- **gRPC streaming** — overkill, doesn't fit web/Flutter equally well.

## See also
- [[module-realtime]] · [[websocket-events]] · [[redis-usage]]
