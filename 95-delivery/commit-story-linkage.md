---
title: Commit ↔ story linkage
tags: [layer/delivery]
status: accepted
phase: both
depends_on: [[story-id-scheme]]
related: [[story-template]]
audience: both
---

# Commit ↔ story linkage

*Every commit related to a story carries its ID. Every story's commits can be listed by `git log --grep`.*

## Commit message shape (Conventional Commits + trailer)

```
<type>(<scope>): <subject>

<body — what & why>

Story: RCAB-Ex.Sy
Sign-off: <name>           # only when a demo or HITL stop signs off
```

### Types we use

| Type | When |
|---|---|
| `feat` | new user-facing capability or new vault concept |
| `fix` | bug fix or correction |
| `docs` | vault content edits that aren't restructures |
| `refactor` | restructure / rename / compression in code or vault |
| `test` | add or change tests; no behavior change |
| `chore` | tooling, deps, CI, .gitignore, frontmatter sweeps |
| `perf` | measurable performance improvement |

### Scopes

- `vault` — Obsidian vault notes
- `api`, `web`, `driver-app`, `infra`, `shared`, `ci` — code areas
- omit scope for monorepo-wide tooling

## Examples

```
feat(api): top-K dispatch service, Redis offer lock, 12s TTL

Wires DispatchService → GeoService → RealtimeBus. Lua script
`dispatch_claim.lua` for atomic offer claim. Wave-2 not yet implemented.

Story: RCAB-E4.S5
```

```
test(api): cover top-K dispatch race conditions

Two drivers tap accept on the same offer within 5ms; first wins,
second receives `offer_expired`. Adds `dispatch.race.spec.ts`.

Story: RCAB-E4.S5
```

```
feat(vault): add demo-cadence and impact-analysis notes

Story: RCAB-E1.S0
```

## How to find a story's commits

```
git log --grep='Story: RCAB-E4.S5'
```

This is the audit trail. PR descriptions should also link to the story file in the vault.

## When a commit serves multiple stories

If a single commit truly serves more than one story (rare — usually a sign you should split), list each:

```
Story: RCAB-E4.S5
Story: RCAB-E4.S6
```

## See also
- [[story-id-scheme]] · [[story-template]] · [[stories-index]]
- [[delivery-roadmap]]
