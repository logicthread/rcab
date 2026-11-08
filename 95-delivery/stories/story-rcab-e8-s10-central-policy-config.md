---
title: RCAB-E8.S10 — Centralize business policy configuration
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S10
demo: 7
estimate: m
hitl: no
depends_on: [[story-rcab-e8-s8-review-remediation-stage-c]]
blocks:
affected_notes: [[policy-config]], [[reading-paths]]
owner: claude
audience: both
---

# RCAB-E8.S10 — Centralize business policy configuration

## Goal

The owner asked to "keep all the decision points together, like fare, max_wait time, etc, so they can be modified in a centralized way and I have a better view of all these configurations". Today those knobs are scattered: some are `getNumber(config, …)` reads repeated in several services (the dispatch timers are read in three places), others are hard-coded constants (offer TTL, quote TTL, the scheduled booking window, the auto-offline sweep, throttles, outbox intervals). This story moves every business knob into one typed, validated table, makes the API fail closed on a bad value, and generates a single overview document from that table so the owner can see every value and the decision behind it. **Behaviour does not change:** same defaults, same windows, same env var names.

## User-facing acceptance criteria

- Given the repo, When the owner opens `docs/POLICY.md`, Then every server business knob is listed once, grouped by category, with env var, default, allowed range, unit, description and decision note; the web and driver-app client knobs are listed too.
- Given an env var set to an invalid value (e.g. `DISPATCH_K1=0`, `SEAT_MULTIPLIER_2=abc`, scheduled wave one longer than the window), When the API starts, Then it refuses to start and the error lists every invalid key without echoing any value.
- Given no policy env vars, When the API runs, Then every fare, timer, window and limit equals its previous hard-coded or default value.

## Technical acceptance criteria

- `apps/api/src/config/policy/policy.schema.ts` is the single declarative table (key, env, type, default, bounds/allowed, unit, category, description, decision) plus cross-field rules.
- `buildPolicy` / `getPolicy` / global `PolicyModule` (`POLICY` token) expose a deep-frozen typed `Policy`; no service calls `getNumber`/`envNumber` or `process.env` for a business knob any more (`common/utils/env.ts` remains the low-level parser).
- Existing env var names keep working; knobs that were constants get new env names only where none existed.
- `apps/web/src/config/policy.ts` and `apps/driver-app/lib/core/config/policy.dart` gather the client knobs in one annotated block each.
- `pnpm policy:doc` writes `docs/POLICY.md` and the policy block of `infra/docker/env.example/api.env.example`; `pnpm policy:doc:check` fails on drift and runs in `pnpm verify` and the Jenkins lint stage.
- Vault: [[policy-config]] explains the mechanism; [[reading-paths]] has `path:change-business-rule`.

## Test plan

- Unit: `policy.spec.ts` — defaults valid and pinned, each per-knob validation rejects bad values, every cross-field rule, fail-closed message lists all keys and never the value, overrides, freezing.
- Unit: `policy-doc.spec.ts` — renderer covers every knob, env block splice is idempotent, drift check names the stale line, client-knob parsers reject drift / undocumented consts.
- Existing unit + integration suites (Testcontainers) pass unchanged in behaviour; specs that configured services through fake `ConfigService`s now pass `buildPolicy(config)`.
- Web vitest + next lint; Flutter test + analyze.

## Out of scope

- Changing any default (that is an owner decision per knob; e.g. RCAB-E8.S9 replaces `pricing.sharedFarePolicy`).
- Runtime (hot) reconfiguration or an admin UI; values are read once at boot.
- Infrastructure config (URLs, secrets, ports, CORS) — stays where it is.

## Notes / questions

- Flagged, not changed: `scheduled.dispatchWaveOneMs` keeps its inclusive bound (wave one may equal the window), as before.
- New cross-field rules (r1 ≤ r2, wave one < hard fail, seat multiplier 3 ≤ 2, shared quote seats ≤ max seats, sweep divides 60 s, geo gate < stale cutoff, access TTL < refresh TTL) hold for the defaults but would now reject odd overrides that previously booted.
- `outbox.maxPublishAttempts` (10) used to be only the migration-0015 column default; the writer now sets it explicitly from policy (same value).
- The outbox publish backoff (`2^attempts` s, capped at 300 s) stays in SQL and is not a knob yet.

## See also

- [[epic-e8-production-hardening]] · [[policy-config]]
- [[story-rcab-e8-s8-review-remediation-stage-c]] · [[story-rcab-e8-s9-shared-fare-readjustment-policy]]
