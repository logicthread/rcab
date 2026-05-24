---
title: RCAB-E1.S9 — System probe & load-capacity estimator (`pnpm system:probe`)
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: yes
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[local-system-probe]], [[performance-budget]], [[testing-strategy]]
owner: claude
audience: both
---

# RCAB-E1.S9 — System probe & load-capacity estimator (`pnpm system:probe`)

## Goal

A single command the developer runs on a new machine (or a candidate VPS) that:

1. Inventories the host (CPU cores, RAM, disk free, Docker version, ports availability).
2. Installs / matches missing deps (with the developer's consent — one prompt per install).
3. Runs a small synthetic load (k6 against a freshly-up stack) and prints an **estimated user-handling envelope** for that host class, derived from the [[performance-budget]] curves.

This gives the developer a number ("this machine can comfortably serve ~N concurrent active drivers under our Phase-0 budget") **before** they commit to a VPS size.

## User-facing acceptance criteria

- `Given` a Mac or Linux dev machine, `When` I run `pnpm system:probe`, `Then` I see a JSON + human-readable report listing host capabilities, missing deps with install hints, and an estimated capacity envelope.
- `Given` missing deps are detected, `When` I confirm at the prompt, `Then` they install via the platform-native package manager (brew on mac, apt on Debian/Ubuntu).
- `Given` the probe runs to completion, `When` I look at the report, `Then` it tells me which Phase-0 KPIs from [[performance-budget]] this host can / cannot meet.

## Technical acceptance criteria

- `scripts/system-probe.mjs` (or similar) — no exotic deps; pure Node + `execa`.
- Detect: Docker, docker compose, pnpm, node ≥ 20, git, available RAM, free disk, free ports for our dev stack.
- Optional consent-gated installs: brew formulae / apt packages for missing pieces.
- Bring up the dev compose if not already up; run a 60s k6 scenario (`infra/load/probe.js`) against quote + dispatch paths; tear down.
- Output: `system-probe-report.json` + a coloured terminal summary.
- The capacity model is conservative: based on the per-request CPU + RAM cost measured in the probe, extrapolated to per-host targets.

## HITL stops

- Before any package install: explicit "yes" needed.
- Before tearing down a stack the dev brought up themselves.

## Test plan

- Unit: dep detection on a mocked host info object.
- Smoke: run the probe in CI on the GitHub-hosted runner; assert it completes and emits a report.

## Out of scope

- Auto-provisioning a VPS — the developer still picks the host.
- Performance regression tracking — that's a separate concern for Phase-1.

## See also
- [[epic-e1-foundation]] · [[local-system-probe]] · [[performance-budget]] · [[testing-strategy]]
