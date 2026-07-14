---
title: RCAB-E1.S10 — Code knowledge graph for agent memory (`pnpm code:graph`)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[module-map]]
owner: claude
audience: both
---

# RCAB-E1.S10 — Code knowledge graph for agent memory (`pnpm code:graph`)

## Goal

Give Claude Code agents a precomputed, queryable map of the codebase so they stop
re-deriving structure by grep/Explore every session, and so doc/code drift becomes
detectable. A single command (`pnpm code:graph`) extracts a graph — files, NestJS
modules, HTTP routes, DB tables, providers — with edges for imports, DI wiring, routes,
FK relations, and Riverpod providers, committed as `codegraph/graph.json` +
`codegraph/graph.md`. A `/code-graph` skill answers "who imports X / what does module Y
depend on / where is route Z" from the artifact instead of scanning source. This is
dev-tooling only — no product code changes.

## User-facing acceptance criteria

- `Given` a checkout, `When` I run `pnpm code:graph`, `Then` `codegraph/graph.json` and
  `codegraph/graph.md` are written with correct counts (16 modules, 22 routes, 9 tables).
- `Given` the graph exists, `When` I invoke `/code-graph deps <Module>` / `importers <file>`
  / `route <METHOD /path>`, `Then` I get the answer from the artifact, not a source grep.
- `Given` a source file changes, `When` the edit lands, `Then` `codegraph/.stale` is
  flagged and `/code-graph` regenerates before answering.
- `Given` `40-backend/module-map.md` disagrees with the code, `When` I run
  `pnpm code:graph:check`, `Then` it exits non-zero and lists the phantom + missing modules.

## Technical acceptance criteria

- `scripts/codegraph/build.mjs` + `extractors/*` — in-repo TypeScript compiler API for TS
  (per-file, syntactic; no ts-morph/madge), regex for Dart. No new heavy deps.
- Node schema `{id, kind, path, name, app, meta}`; edge schema `{from, to, kind, meta}`.
  Node kinds `file|module|symbol|route|table`; edge kinds
  `imports|di-import|di-provides|route|fk|riverpod-provides`.
- `codegraph/graph.json` + `graph.md` committed; `codegraph/.stale` + `memory-ingest.json`
  gitignored.
- `.claude/skills/code-graph/SKILL.md` answers structural queries via `jq`.
- `.claude/hooks/mark-codegraph-stale.sh` (PostToolUse Edit|Write) flags staleness on
  `apps/**|packages/**` source changes; never blocks.
- `scripts/codegraph/drift-check.mjs` (`pnpm code:graph:check`) cross-checks module-map.md.
- Optional `--push-memory` emits `memory-ingest.json` for `mcp__memory__` (off by default).

## Test plan

- Verification: counts asserted against source greps (`grep -rl @Module` = 16;
  `@(Get|Post|Put|Patch|Delete)\(` = 22; `pgTable\(` = 9; dart files in `lib/` = 37).
- Spot-checks: `RidesModule` DI deps, FK edges (`rideStop→sharedRide`, `driver→appUser`),
  route resolution (`POST /v1/rides → RidesController.create`).
- Drift-check exits non-zero against the current (drifted) `module-map.md`.

## Out of scope

- Type-resolved import edges (barrel re-exports may under-resolve — documented in graph.md).
- A graph DB or server (Phase-0: single-repo tooling only, per [[ADR-0009-single-vps-phase-0]]).
- Fixing the `module-map.md` drift itself — detection ships here; the fix is a follow-up.

## Notes / questions

- Discovered live: `40-backend/module-map.md` lists phantom modules
  (`clients, geo, notifications, shared-rides, users`) and omits real ones
  (`health, pricing, ride-lifecycle, vehicles`). `code:graph:check` now catches this.
- Freshness hook registration in `.claude/settings.json` is applied by the developer
  (agent-config self-modification is guarded).

## See also
- [[epic-e1-foundation]] · [[stories-index]] · [[module-map]] · [[commit-story-linkage]]
