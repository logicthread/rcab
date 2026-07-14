---
title: RCAB-E1.S13 — Wire e2e + load CI scripts, first Playwright spec
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: yes
depends_on: [[story-template]], [[testing-strategy]]
affected_notes: [[testing-strategy]]
owner: claude
audience: both
---

# RCAB-E1.S13 — Wire e2e + load CI scripts, first Playwright spec

## Goal

`Jenkinsfile.nightly` called `pnpm test:e2e` and `pnpm test:load` — **neither script
existed**, so the nightly pipeline failed on undefined scripts. Playwright specs: zero;
Flutter `integration_test/`: empty. Wire the missing scripts and land a first real web
e2e that guards the exact bug classes that shipped to Demo 1 (CORS, reCAPTCHA StrictMode,
render) and were only caught by manual testing.

## User-facing acceptance criteria

- `Given` the dev stack is up, `When` I run `pnpm test:e2e`, `Then` the Playwright suite
  runs and the sign-in spec passes.
- `Given` the stack is up, `When` I run `pnpm test:load`, `Then` k6 executes the load
  scenarios against the API.
- `Given` `Jenkinsfile.nightly`, `Then` `test:e2e` / `test:load` are defined scripts (no
  longer undefined).

## Technical acceptance criteria

- `@playwright/test` + chromium installed (HITL-approved system packages); `k6` installed.
- Root `package.json`: `test:e2e` → `turbo test:e2e`, `test:load` → `k6 run infra/load/probe.js`.
- `apps/web`: `test:e2e` → `playwright test`; `playwright.config.ts` (baseURL :3002, no
  managed webServer — the app is a compose service); `e2e/signin.e2e.spec.ts`.
- First spec asserts: sign-in renders, no reCAPTCHA `Cannot read properties of null`
  pageerror, and a preflighted cross-origin POST to the API is not blocked (CORS).
- Playwright artifacts gitignored.

## Test plan

- e2e: `pnpm dev:up` → `pnpm test:e2e` → sign-in spec green (verified locally, 1.1s).
- load: `pnpm test:load` → k6 scenarios run against `/v1/health/ready` (verified locally).

## HITL stops

- Installing Playwright browsers + k6 (system packages) — **approved** this session.

## Out of scope

- Flutter `integration_test/` smoke — needs an emulator/device (its own setup + HITL);
  tracked as a follow-up.
- Full OTP→book e2e (needs Firebase test-phone provisioning) — later e2e.
- Turning on the nightly e2e/load stages in CI infra — scripts exist now; enabling is ops.

## See also
- [[epic-e1-foundation]] · [[testing-strategy]] · [[story-rcab-e1-s12-concurrency-tests]]
