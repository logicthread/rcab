---
title: ADR-0001 — Backend on NestJS
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[tech-stack]], [[nestjs-structure]], [[service-boundaries]]
audience: both
---

# ADR-0001 — Backend on NestJS (Node + TypeScript)

*The backend runs on Node 20 with NestJS 10 and TypeScript end-to-end.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

We need a backend that supports HTTP REST + WebSockets, plays well with low-latency dispatch logic, fits a single VPS for Phase-0, and is approachable to LLM-assisted code generation. Team JS familiarity is high; Python and Go are credible alternatives.

## Decision

Use **NestJS 10 on Node 20 with TypeScript**.

## Consequences

- Positive
  - One language (TS) across backend and web — shared types and DTOs.
  - Module system maps cleanly to our service-boundary plan (see [[service-boundaries]]).
  - First-class Socket.IO integration; the realtime path is straightforward.
  - Huge ecosystem; Drizzle, BullMQ, pino, class-validator all mature.
  - LLM tooling generates idiomatic NestJS reliably.
- Negative
  - Node is single-threaded — top-K dispatch fan-out under heavy concurrency is bounded; mitigated by Redis lock + offloading where helpful.
  - NestJS decorators add a layer of magic for newcomers.
- Neutral
  - Performance is "good enough" for Phase-0 targets; Phase-1 horizontal scaling is in [[scaling-strategy]].

## Alternatives considered

- **Python + FastAPI** — equally fast to develop, but Socket.IO and BullMQ-equivalents are thinner; type sharing with the TS frontend is harder.
- **Go (Gin/Fiber)** — best for high-concurrency dispatch, but more boilerplate, and the team would slow down for Phase-0.

## See also
- [[tech-stack]] · [[nestjs-structure]] · [[service-boundaries]] · [[scaling-strategy]]
