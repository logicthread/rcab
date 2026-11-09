---
title: RCAB-E8.S12 — Business metrics and realistic load scenarios
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S12
demo: 7
estimate: m
hitl: no
depends_on: [[story-rcab-e8-s10-central-policy-config]], [[performance-budget]]
blocks:
affected_notes: [[performance-budget]], [[policy-config]], [[observability]]
owner: claude
audience: both
---

# RCAB-E8.S12 — Business metrics and realistic load scenarios

## Goal

Review finding F17 (remediation guide R12): `apps/api/src/metrics.ts` declared dispatch, ride, pool, outbox and driver metrics that nothing ever updated, HTTP metrics were labelled by the raw `req.path` (one time series per ride id), and the only load test hit `/v1/health/ready`. This story gives every business metric a real call site (or deletes it), labels HTTP metrics by route template, proves the counters move with an integration test, and adds k6 workloads that exercise quote, ride create, offer contention and driver location the way real clients do.

## User-facing acceptance criteria

- Given a ride is requested and offered, When the first offer reaches a driver, Then `rcab_dispatch_latency_seconds{stage="intent_to_first_offer"}` observes the outbox-intent to first-offer time, and `offer_to_accept` observes the accept.
- Given rides are dispatched, assigned, declined, expired or exhausted, Then `rcab_dispatch_outcome_total{outcome,kind}` counts each (including `scheduled_retry`).
- Given pools fill, time out or refuse a joiner, Then `rcab_pool_joins_total{result}` and `rcab_pool_closures_total{reason}` move, and `rcab_shared_match_rate` reports riders who shared over riders in closed pools.
- Given the outbox has a backlog, Then `rcab_outbox_pending`, `rcab_outbox_oldest_pending_age_seconds` and `rcab_outbox_exhausted` mirror the table.
- Given a request for `/v1/rides/<uuid>`, Then the HTTP metric label is `/v1/rides/:id`; an unmatched URL is the fixed label `unmatched`.

## Technical acceptance criteria

- No label carries an id (ride, driver, offer, pool).
- Sampled gauges (active / busy drivers, outbox, match rate) refresh on `observability.sampleIntervalMs`; the window is `observability.matchRateWindowMs`. Both live in `policy.schema.ts`.
- Load budgets (API p95 / p99, quote p95, dispatch p95, 5xx error budget, minimum business success, driver location cadence) live in the `perfBudget` category of the policy schema, show up in `docs/POLICY.md`, and are generated into `infra/load/perf-budget.generated.json`.
- k6 identities come from `infra/load/prepare-dev.mjs`: ordinary signed tokens for fixture users, minted with the dev stack's own `JWT_SECRET`. The API gains no endpoint or flag, and the script refuses `NODE_ENV=production`, a non-loopback `API_BASE` and a non-dev compose project.
- The e2e CORS assertion in `signin.e2e.spec.ts` requires 401 from the API, not "any status".
- Grafana panels (`infra/observability/grafana/dashboards/dispatch.json`) query the new metric names. No alert rules are added.

## Test plan

- Unit: metrics middleware route label (uuid collapses to `/v1/rides/:id`), dispatch service / processor / outbox relay / gateway call sites, business-metrics sampler, policy doc.
- Integration: `test/integration/business-metrics.int.spec.ts` drives known activity and asserts registry deltas; neighbours `scheduled-retry`, `pool-lifecycle`, `outbox-dispatch`, `dispatch-pool`.
- Load: `infra/load` workloads (quote, ride create with idempotency keys and replay, offer fan-out and accept contention over Socket.IO, driver location cadence), run briefly as a smoke.

## Out of scope

- Alert rules, new dashboards beyond re-pointing existing panels.
- A capacity claim: the smoke run proves the paths work, not what the stack can carry.
- Product-decision values outside the perfBudget category.

## Notes / questions

- `driver:location` has no ack, so its latency cannot be measured from the client; the workload asserts the socket survives at the configured cadence.

## See also

[[epic-e8-production-hardening]], [[story-rcab-e8-s10-central-policy-config]], [[performance-budget]], [[policy-config]]
