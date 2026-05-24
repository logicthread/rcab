---
title: RCAB-E1.S1 — Scaffold the monorepo (pnpm + turborepo + apps + packages)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[ADR-0007-monorepo-layout]], [[nestjs-structure]], [[web-nextjs-structure]], [[driver-flutter-structure]]
owner: claude
audience: both
---

# RCAB-E1.S1 — Scaffold the monorepo (pnpm + turborepo + apps + packages)

## Goal

Stand up the empty monorepo skeleton: pnpm workspaces, Turborepo orchestration, `apps/api`, `apps/web`, `apps/driver-app`, `packages/shared`, `packages/api-client`. Builds and tests run from the root with one command. No business logic yet.

## User-facing acceptance criteria

- `Given` a fresh clone, `When` I run `pnpm install && pnpm build`, `Then` every workspace compiles with zero warnings.
- `Given` a fresh clone, `When` I run `pnpm test`, `Then` placeholder tests in every TS workspace pass.
- `Given` the Flutter app, `When` I run `flutter analyze` and `flutter test` from `apps/driver-app/`, `Then` both pass.

## Technical acceptance criteria

- `pnpm-workspace.yaml` declares `apps/*` and `packages/*`.
- `turbo.json` defines `build`, `lint`, `test`, `dev` pipelines with correct `dependsOn` edges.
- `packages/shared/` exports a tiny placeholder type (e.g., `export type Health = { ok: boolean }`) consumed by `apps/api` and `apps/web` to prove cross-workspace imports work.
- `tsconfig.base.json` at root; each TS workspace extends it.
- `.editorconfig`, `.prettierrc`, `.eslintrc` (or flat config) at root; per-workspace overrides only when needed.
- `apps/driver-app/` initialized with `flutter create` (Android-only target).
- README.md at root with the bring-up commands.

## Test plan

- Unit: one trivial test in each TS workspace + one widget test in `driver-app`.
- Integration: none yet.
- CI: covered by [[story-rcab-e1-s5-ci-cd]].

## Out of scope

- Any business logic.
- Any Docker work (that's [[story-rcab-e1-s2-docker-dev]] et al.).

## See also
- [[epic-e1-foundation]] · [[ADR-0007-monorepo-layout]] · [[nestjs-structure]] · [[web-nextjs-structure]] · [[driver-flutter-structure]]
