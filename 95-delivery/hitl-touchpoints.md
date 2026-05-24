---
title: Human-in-the-loop touchpoints
tags: [layer/delivery]
status: accepted
phase: 0
depends_on: [[delivery-roadmap]]
related: [[demo-cadence]], [[impact-analysis]], [[testing-strategy]]
audience: both
---

# Human-in-the-loop touchpoints

*Where Claude pauses and asks the developer to look. These are the explicit checkpoints — not "ask whenever in doubt."*

## Hard stops (Claude must wait)

| When | What to confirm | Where it shows up |
|---|---|---|
| **Before bumping a roadmap demo's headline** | Are we still aiming at the same thing? | [[impact-analysis]] |
| **Before reordering or splitting/merging epics** | Yes / no on the new shape | [[impact-analysis]] |
| **Before writing a new ADR or superseding one** | Decision text + alternatives reviewed | [[conventions]] §ADRs |
| **Before deploying to a real VPS (any demo ≥ 7)** | Smoke test list, secrets present, backup verified | [[secrets-management]], [[backups]] |
| **Before any change that touches secrets handling** | Key rotation plan, audit reasoning | [[secrets-management]] |
| **Before adding a new external dependency** with cost or vendor lock-in implication | Cost estimate, ADR if material | [[ADR-0004-osm-for-booking-google-for-nav]] for template |
| **At the end of every demo** | Walk-through on a real device + sign-off | [[demo-cadence]] |
| **When a test is flaky and we'd quarantine** | "Quarantine or fix" judgment | [[testing-strategy]] |
| **When a story's acceptance criteria change mid-flight** | Approve revision; run [[impact-analysis]] | [[story-template]] |

## Soft stops (Claude proceeds with default but flags)

| When | What Claude does |
|---|---|
| **Choosing between two reasonable libraries** | Picks one, flags in the PR description with the rejected alternative |
| **Performance optimization vs. simplicity trade-off** | Picks simplicity; flags in the PR if a measurable budget item is at risk |
| **Test data / fixture choice** | Picks plausible; lists in the PR |

## What "sign-off" looks like

- Demo walk-through: developer runs the demo from a fresh `docker compose up` on their own machine, exercises the user-facing flow, looks at the Grafana panels for this demo.
- Confirms in the PR (or in chat): "Demo N signed off" plus any micro-issues to file as new stories.
- The merging commit contains `Sign-off: <name>` in its trailer.

## Where Claude should NOT stop

- Routine refactors that don't change behavior.
- Vault edits that don't touch ADRs, decisions, or stories.
- Adding tests.
- Fixing failing tests with an obvious cause.
- Bumping minor / patch dependencies covered by lockfile.

## See also
- [[delivery-roadmap]] · [[demo-cadence]] · [[impact-analysis]]
- [[story-template]] · [[testing-strategy]] · [[secrets-management]]
