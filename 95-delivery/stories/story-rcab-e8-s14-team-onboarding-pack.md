---
title: RCAB-E8.S14 — Team onboarding pack (walkthrough, state machines, role guides, demo videos)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S14
demo: 7
estimate: l
hitl: yes
depends_on: [[story-rcab-e8-s10-central-policy-config]]
blocks:
affected_notes:
owner: claude
audience: both
---

# RCAB-E8.S14 — Team onboarding pack

## Goal

A new team can take over rcab. Deliver under `docs/onboarding/`: system overview, one functionality file per area, state machines (mermaid, derived from code), one file per development workflow, role guides (UI/UX, backend, monitoring/maintenance, DevOps, senior architect, manager, and stakeholders for the passenger app, driver app, maintainer and monitoring), and recorded videos of every passenger web, driver app and ops workflow with re-recordable harnesses. Bugs found while recording are fixed with regression tests.

## Acceptance criteria

- `docs/onboarding/README.md` routes each role to its guide; every guide links to the workflows, functionality, state machines and video IDs it relies on.
- Videos W01–W10 (web), D01–D08 (driver app), M01–M06 (ops) exist with `INDEX.md` per area and a harness to regenerate them (`pnpm demo:record:web`, `scripts/demo/record-driver.sh`, `pnpm demo:record:ops`).
- No backdoor in shipped code: demo sessions come from test-harness-only token minting.
- `pnpm verify` stays green.
- A presentation deck of the recordings is published for the team.

## HITL sign-off

- Owner reviews the pack and deck before it goes to the new team.
