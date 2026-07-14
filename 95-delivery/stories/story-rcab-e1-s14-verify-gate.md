---
title: RCAB-E1.S14 — Verification gate (coverage floor + `pnpm verify`)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: no
depends_on: [[story-template]], [[story-rcab-e1-s11-int-teardown-fix]]
affected_notes: [[testing-strategy]]
owner: claude
audience: both
---

# RCAB-E1.S14 — Verification gate (coverage floor + `pnpm verify`)

## Goal

Story `■`-done status was hand-maintained with no automated "still green" proof — the
core verification-debt risk. Add a single gate (`pnpm verify`) that a story must pass to
be called done, enforce an API coverage floor so coverage can't silently rot, and wire it
into CI + `/close-story`. Also fix `pnpm test` hanging locally so the gate is runnable
off the compose network.

## User-facing acceptance criteria

- `Given` a checkout with Docker up, `When` I run `pnpm verify`, `Then` it runs lint +
  API unit-with-coverage + integration and exits 0 only if all pass.
- `Given` coverage drops below the floor, `When` `pnpm verify` runs, `Then` it fails.
- `Given` a bare local host (no compose network), `When` I run `pnpm test`, `Then` the
  API unit suite passes (no `app.spec` hang on the `redis` hostname).

## Technical acceptance criteria

- `apps/api/vitest.config.ts`: v8 coverage with thresholds — floors set just under the
  measured unit baseline (stmts/lines 75, branches 85, funcs 70; measured 78.4/88/73.3).
  `@vitest/coverage-v8` added.
- `apps/api` `test:cov` script; root `verify` = `lint && @rcab/api test:cov && test:int`.
- `app.spec.ts` no longer hangs: unit vitest `env` sets `RCAB_DISABLE_BULL_AUTORUN=1` +
  `RCAB_DISABLE_WS_ADAPTER=1` (the A1 seams) so the unit-booted AppModule doesn't eagerly
  connect to the compose `redis` host.
- `Jenkinsfile` Unit stage runs `@rcab/api test:cov` (coverage gated in CI).
- `/close-story` step 2 runs `pnpm verify` as the story-done proof.

## Test plan

- `pnpm verify` green locally: lint ✔ (5 pkgs), unit 285 pass @ 78.4/88/73.3/78.4 cov,
  int 91 pass.
- Coverage floor enforces: bumping the lines floor to 95 fails `test:cov` (exit 1);
  at 75 it passes (exit 0) — verified.
- `pnpm test` exits 0 on a bare host (app.spec no longer times out).

## Out of scope

- Web coverage floor (only 3 web unit specs; brittle to gate now) — follow-up.
- Raising the API floor toward the integration-covered level (needs unit tests for
  integration-only paths) — future ratchet.
- The ~1/18 int flake (unproven seed collision) — analysis shows collision prob ≪ 5% at
  these insert volumes; unreproducible in 15 runs, left noted not chased.

## See also
- [[epic-e1-foundation]] · [[testing-strategy]] · [[story-rcab-e1-s13-e2e-load-wiring]]
