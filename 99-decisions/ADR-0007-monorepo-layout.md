---
title: ADR-0007 — Monorepo layout (pnpm workspaces + Flutter sub-app)
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[tech-stack]], [[ci-cd]]
audience: both
---

# ADR-0007 — Monorepo layout

*One git repo. Pnpm workspaces for JS/TS; Flutter app as a sibling.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

Three codebases share types and conventions: NestJS backend, Next.js web, Flutter driver app. Two of them share a language (TS) and benefit from shared packages.

## Decision

Use a **monorepo**:

```
rcab/                    # this Obsidian vault is at the same root
  apps/
    api/                 # NestJS
    web/                 # Next.js
    driver-app/          # Flutter
  packages/
    shared/              # shared TS types + zod schemas
    api-client/          # generated typed client (OpenAPI from api/)
  pnpm-workspace.yaml
  turbo.json             # Turborepo for build orchestration
```

The vault sits at the root (this very `00-index/`, `10-product/`, …) so docs live with code without a separate sub-folder.

## Consequences

- Positive
  - Shared types end-to-end — Zod schemas in `packages/shared` are the source of truth.
  - Atomic PRs touching backend + web.
  - One CI pipeline; one version control story.
- Negative
  - Flutter is outside the pnpm workspace; we wire it manually in CI.
  - Slightly larger checkout for contributors.
- Neutral
  - Turborepo caching reduces CI time.

## Alternatives considered

- **Polyrepo** — would force OpenAPI sync between repos, slower iteration.
- **Nx instead of Turborepo** — feature-rich but heavier; Turborepo is sufficient for Phase-0.

## See also
- [[tech-stack]] · [[ci-cd]] · [[nestjs-structure]] · [[web-nextjs-structure]] · [[driver-flutter-structure]]
