---
title: ADR-0002 — Web client on Next.js
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[tech-stack]], [[web-nextjs-structure]], [[web-pwa-strategy]]
audience: both
---

# ADR-0002 — Web client on Next.js

*Next.js 14 (App Router) as a PWA for the client booking app.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

The client app is web-first for the first few months. It must work well on low-end Android browsers in tier-2/3 India, install as a PWA, and preserve a path to native (React Native) later.

## Decision

Use **Next.js 14 (App Router)**. Authenticated app shell is exported as static and served by nginx; marketing routes may use SSR.

## Consequences

- Positive
  - Image / font / bundle optimizations out of the box.
  - PWA works.
  - Code-share path to React Native later (TS + React).
  - Type sharing with NestJS backend (shared monorepo package).
- Negative
  - App Router has a learning curve.
  - Server Components vs. Client Components needs discipline so we don't accidentally ship megabytes of JS.

## Alternatives considered

- **SvelteKit** — smaller bundles; ruled out because of weaker shared-code path to native.
- **Vite + React SPA** — simpler; we'd lose SSR/PWA niceties.

## See also
- [[tech-stack]] · [[web-nextjs-structure]] · [[web-pwa-strategy]]
