# Workflow: changing business configuration (fares, timers, thresholds, rules)

Every product decision that is a number or a list — fares, dispatch radii and timers, the scheduled-booking
window, pool matching thresholds, who may cancel from which state, session lifetimes, rate limits, realtime
cadence, the outbox loop, load-test budgets — lives in **one typed table**, with its env var, default, bounds,
unit and the decision behind the default. The generated overview is [`docs/POLICY.md`](../../POLICY.md); read it
to find a knob, read this page to change one.

## 1. Where things live

| What | File |
|---|---|
| The table (pure data, no Nest imports) | `apps/api/src/config/policy/policy.schema.ts` (`POLICY_SCHEMA`, `POLICY_RULES`) |
| Boot-time builder: env -> validated, frozen `Policy` | `apps/api/src/config/policy/policy.ts` (`buildPolicy`, `getPolicy`, DI token `POLICY`) |
| Doc generator | `apps/api/src/config/policy/policy-doc.ts`, driven by `scripts/policy-doc.ts` |
| Generated outputs | `docs/POLICY.md`, the policy block of `infra/docker/env.example/api.env.example`, `infra/load/perf-budget.generated.json` |
| Web client knobs (not server-owned) | `apps/web/src/config/policy.ts` (`WEB_POLICY` + `WEB_POLICY_META`) |
| Driver app client knobs | `apps/driver-app/lib/core/config/policy.dart` (`DriverPolicy`) |
| Specs | `policy.spec.ts`, `policy-doc.spec.ts` next to the schema |
| Not policy (stays elsewhere) | DB/Redis URLs, secrets, ports, CORS: `apps/api/src/common/guards/auth-config.ts` and the infra modules |

Categories in the table: `pricing`, `dispatch`, `scheduled`, `matching`, `rides`, `drivers`, `realtime`,
`sessions`, `idempotency`, `rateLimits`, `outbox`, `observability`, `perfBudget`. Knob kinds: `int`, `number`,
`bool`, `enum`, `duration-ms` (`ms()`), `list` (`listOf`).

## 2. How a value is resolved

1. `buildPolicy()` reads each knob's `env` var through the same config reader the app uses (or a plain record in
   tests) and parses it by type, bounds (`min`/`max`) and allowed set.
2. A knob with `env: null` is **code-fixed**: you change it by editing its `default` in the schema (it applies to
   every environment). Example: `rides.clientCancellableFrom` / `driverCancellableFrom`.
3. A default can be **derived** from earlier knobs (`{label, compute}`), e.g. `scheduled.dispatchWaveOneMs` defaults
   to half of `scheduled.dispatchWindowMs`. The derived default recomputes if you override its source.
4. Every cross-field rule in `POLICY_RULES` is checked. Today's ten rules include: wave 2 before hard fail
   (`dispatch.waveOneTimeoutMs < hardFailMs`); `r1Meters <= r2Meters`; scheduled `waveOneMs <= windowMs`;
   `minLeadMs < maxLeadMs`; a fuller pool is never dearer (`seatMultiplier3 <= seatMultiplier2`);
   `sharedQuoteSeats <= matching.maxSeats`; the auto-offline sweep is a whole-seconds divisor of 60;
   `realtime.geoIndexGateMs < drivers.staleAfterMs`; `perfBudget.apiP95Ms <= apiP99Ms`; access TTL < refresh TTL.
5. **Fail closed.** Any invalid value or broken rule aborts boot with an error listing *every* bad key and its env
   var, never the raw value (the same environment holds secrets). A deploy with a bad override therefore fails
   its health check and `deploy.sh` rolls back (see [release-and-deploy.md](release-and-deploy.md)).
6. The result is frozen (`Object.freeze`, including list knobs) and injected as `POLICY` or read via `getPolicy()`.
   A few modules read `getPolicy()` at import time (e.g. the cancellable-state sets, BullMQ worker concurrency, the
   sweep cron expression), so those knobs only take effect after a **process restart**, which a redeploy does anyway.

## 3. Procedure: change a rule

**A. Change it for every environment (the default moves)**

1. Edit `default` **and** `decision` of the knob in `policy.schema.ts`. The `decision` string records who decided
   and when ("owner 2026-11-08: …"); an unexplained default is a review blocker.
2. If the change breaks a cross-field rule, fix the other knob in the same change.
3. Regenerate: `pnpm policy:doc` (updates `docs/POLICY.md`, `api.env.example`, the k6 budget file).
4. Update tests that pin the old value (grep the old number; scheduled and dispatch timers are asserted in
   `scheduled-window.spec.ts`, `dispatch.service.spec.ts`, the integration specs).
5. If a client mirrors it (`server-mirror` in `WEB_POLICY_META` / `policy.dart` — e.g. the 5-minute no-show wait,
   the offer TTL fallback), change the mirror too; the generator fails if a client knob has no meta entry.
6. Update the vault note that quotes the number (`70-algorithms/`, `40-backend/policy-config.md`, the feature note)
   in the same PR, and run `pnpm verify` (it runs `policy:doc:check`).
7. A change to a **story's acceptance criteria or a demo headline** is a HITL stop; a pure tuning change is not.

**B. Change it for one deployment only**

Set the env var in that environment's api env file (`infra/docker/env.example/api.env.example` is the template;
on the VPS the real files are owner-managed under `/opt/rcab/compose/env/`, see
[`scripts/deploy/README.md`](../../../scripts/deploy/README.md)). No code change, no doc change; restart the api.
Do not put secrets handling changes in this flow: that is a HITL area (`80-infrastructure/secrets-management.md`).

**C. Add a new knob**

1. Add it under the right category with `int()/num()/ms()/oneOf()/listOf()`, giving `env`, `default`, bounds, `unit`,
   `description`, `decision`.
2. Read it from the injected `Policy` (preferred) rather than `process.env`; avoid module-scope reads unless the
   framework forces it (decorators such as `@Interval`, `@Processor` options).
3. Add a validation case to `policy.spec.ts` if it has bounds or a cross-field rule.
4. `pnpm policy:doc` and commit the regenerated files.

## 4. Common asks, mapped to knobs

| Ask | Knob(s) (env var) | Notes |
|---|---|---|
| Offers time out too fast | `dispatch.offerTtlMs` (`DISPATCH_OFFER_TTL_MS`, 12 s) | The driver app counts down from the `ttlMs` the server sends; the server DB clock is authoritative. |
| Search wider / longer | `dispatch.k1/k2`, `r1Meters/r2Meters` (2 km / 4 km), `waveOneTimeoutMs` (30 s), `hardFailMs` (60 s) | `waveOneTimeoutMs < hardFailMs` is enforced. |
| Scheduled booking window | `scheduled.minLeadMs` 15 min, `maxLeadMs` 24 h, `wakeLeadMs` 10 min, `dispatchWindowMs` 4 min, `retryCutoffAfterPickupMs` 30 min | The cutoff decides when a never-answered scheduled ride finally ends as `no_driver`. |
| Fares | `pricing.fareBaseCents/PerKm/PerMin`, `seatMultiplier2/3`, `platformCommissionRate`, `quoteTtlMs` | Money is integer paise; the shared fare is `fixed_at_join` (stand-in policy, migration 0017). |
| Pool size / patience | `matching.maxSeats` 3, `poolTimeoutMs` 60 s, `prefilterRadiusM`, `detourBudgetM`, `similarityThreshold`, `joinPriceRetries` | |
| Who can cancel and when | `rides.clientCancellableFrom`, `driverCancellableFrom` (code-fixed lists), `noShowWaitMs` (5 min) | State vocabulary in [state-machines.md](../state-machines.md#1-solo-ride-ridesstatus). |
| Driver offline sensitivity | `drivers.staleAfterMs` 60 s, `autoOfflineSweepMs` 15 s, `realtime.geoIndexGateMs` 3 s | The heartbeat must be faster than the stale cutoff (enforced). |
| Session lengths | `sessions.accessTokenTtlS` 900, `refreshTokenTtlMs` 30 d, `refreshReuseGraceS` 10 | Reuse grace is what separates a racing refresh from a replay attack. |
| Rate limits | `rateLimits.globalLimit/globalWindowMs` (1000 per 60 s), `authLimit/authWindowMs` (10 per 60 s) | Global throttler plus the stricter auth routes (env `THROTTLE_*`). |
| Outbox loop | `outbox.relayPollMs`, `relayBatchSize`, `relayLeaseMs`, `maxAttempts`, `reconcileIntervalMs` | Alert if `rcab_outbox_exhausted` is non-zero (see [incident-and-recovery.md](incident-and-recovery.md)). |
| Load-test pass/fail | `perfBudget.*` | Flows into `infra/load/perf-budget.generated.json` used by k6. |

## 5. Checklist before you push

- [ ] `decision` text updated with who/when.
- [ ] `pnpm policy:doc` run; `git diff` shows only the expected generated hunks.
- [ ] Client mirrors updated (web `WEB_POLICY`/meta, driver `policy.dart`) if the knob is mirrored.
- [ ] Tests that pin the old value updated; `pnpm verify` green.
- [ ] Vault notes quoting the old number updated.
- [ ] For a production override: change recorded in the release notes, and the deploy verified (`verify-release.sh`).
