---
title: Demo cadence — per-story / per-demo contract
tags: [layer/delivery]
status: accepted
phase: 0
depends_on: [[delivery-roadmap]]
related: [[hitl-touchpoints]], [[stories-index]], [[commit-story-linkage]], [[impact-analysis]]
audience: both
---

# Demo cadence

*The rhythm of work: story → demo → sign-off → next epic.*

## Story lifecycle

A story moves through these states (see [[story-id-scheme]] for the symbol legend):

```
draft (·) → ready (□) → in_progress (▶) → done (■)
                                         ↘ blocked (×) | dropped (–)
```

| Transition | Who | Gate |
|---|---|---|
| `draft → ready` | developer (human) | story file complete: goal, criteria, test plan, affected_notes |
| `ready → in_progress` | Claude | pick up the lowest-numbered ready story in the current epic |
| `in_progress → done` | Claude + developer | all acceptance criteria pass; tests green; vault updated |
| `in_progress → blocked` | Claude | flags blocker to developer via HITL stop |

Claude picks up at most **one story at a time** per epic. A story must reach `done` before the next is started (except when a story is blocked — then skip to the next `ready` one in the same epic and file a blocker note).

## Story-done definition (per story)

A story is `done` when **all** of:

1. Every acceptance criterion has a passing test (unit, integration, or e2e as appropriate).
2. Every `affected_notes` note in the story's frontmatter has been updated to reflect the implementation.
3. All commits carry the `Story: RCAB-Ex.Sy` trailer (see [[commit-story-linkage]]).
4. `turbo build` and `turbo test` are green from a clean checkout.
5. No vault link is dangling (every `[[wiki-link]]` resolves to a real file).

## Demo-done definition (per demo)

A demo is `done` when **all** of:

1. Every story in the epic is `■ done`.
2. The demo flow runs against `docker compose up` from a fresh checkout — no manual steps beyond README.
3. CI (GitHub Actions) is green: unit + integration + the demo's e2e.
4. Relevant Grafana panels show real data; [[performance-budget]] numbers are within budget for this stage.
5. Developer has personally walked the demo flow and issued sign-off (see [[hitl-touchpoints]]).

The sign-off commit carries `Sign-off: <name>` in its trailer.

## Cadence within a demo

```
for each story in epic (lowest ID first):
  1. Mark story in_progress in stories-index.md
  2. Load minimum vault notes (path:work-a-story)
  3. Implement: code + vault updates in the same PR
  4. Tests green → mark done
  5. Commit with Story: trailer

when all stories done:
  HITL stop → developer demo walk-through
  → sign-off commit
  → start next epic
```

## What Claude must not do between stories

- Must not start the next story while one is `in_progress`.
- Must not skip a story without flagging it as `blocked` and explaining why.
- Must not mark a story `done` without passing tests.
- Must not call a demo done without developer sign-off.

## Inter-demo handover

After sign-off, Claude:

1. Updates the demo's epic note status to `done`.
2. Updates `stories-index.md` to show all stories as `■`.
3. Updates [[delivery-roadmap]] "Status snapshot" if applicable.
4. Opens the next epic's note and reports its stories to the developer.

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[hitl-touchpoints]]
- [[commit-story-linkage]] · [[story-template]] · [[impact-analysis]]
