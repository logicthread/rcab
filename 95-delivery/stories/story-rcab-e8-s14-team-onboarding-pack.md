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

## Bugs fixed during the pass

API (found while writing the functionality pages; each with tests):

- 74a1b38: Nest `Logger` now goes through pino (`PinoNestLogger`, `app.useLogger`); credential-like fields are redacted.
- 7c31b31: `ValidationPipe` 400s return `validation_error`; 5xx are logged via pino; OSRM failures return `routing_unavailable`.
- 18a6069: a plate owned by another driver returns 409 `vehicle_reg_exists` on create and update (was 500).
- d130abb: the auto-offline sweep uses `SCAN` instead of `KEYS`.
- 3a80460: socket CORS uses the `resolveBrowserOrigins()` allowlist; `driver:location` is ignored for offline drivers.
- f581d09: nginx `api.conf` returns 404 for `/metrics` on the public vhost.

Web (`docs/onboarding/videos/web/INDEX.md`): Now/Later scheduling picker and `scheduledFor` on ride responses (W08); readable shared-pool status instead of raw enums (W07); `no_show` treated as terminal when restoring or clearing the active ride (W05, fd8b2ca); real landing page (W01).

Driver app (`docs/onboarding/videos/driver/INDEX.md`): location foreground service declared in the manifest, heartbeat while parked, permission request and no (0, 0) fallback on go online; cold-start vehicle pre-check removed; offers survive an offline/online cycle; `ride:subscribe` and `arrivedAt` so passenger cancels and the no-show button work; vehicle profile JSON casing and API error envelope parsing; shared-ride rating prompt, keyboard overflow, passenger labels, stale form errors; sign-out; decline and lost-offer notices.

Ops (`docs/onboarding/videos/ops/INDEX.md`): no product bugs recorded; the index lists only open Phase-0 gaps (no Alertmanager notifier, redis/postgres exporters missing in prod).

## HITL sign-off

- Owner reviews the pack and deck before it goes to the new team.
