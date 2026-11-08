---
title: Business policy configuration
tags: [layer/backend, kind/config]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[module-dispatch]], [[module-matching]], [[module-rides]], [[module-auth]], [[features-top-k-dispatch]], [[features-scheduled-booking]], [[features-shared-rides]], [[story-rcab-e8-s10-central-policy-config]]
audience: both
---

# Business policy configuration

*Every business decision point (fare, offer TTL, wave timers, scheduled window, pool timeout, no-show wait, token lifetimes, rate limits, outbox cadence, …) lives in one typed, validated table. Introduced by [[story-rcab-e8-s10-central-policy-config]].*

**The overview of all values is generated: [`docs/POLICY.md`](../docs/POLICY.md).** Read that, not the code, to see what a knob is set to and why.

## Mechanism

| Piece | Where | Role |
|---|---|---|
| Schema | `apps/api/src/config/policy/policy.schema.ts` | One declarative table: key (`dispatch.offerTtlMs`), env var, type (`int` / `number` / `bool` / `enum` / `duration-ms` / `list`), default, bounds or allowed values, unit, category, description, and a `decision` note (where the default came from). Plus the cross-field rules (`POLICY_RULES`, e.g. scheduled wave one ≤ window). |
| Builder | `apps/api/src/config/policy/policy.ts` | `buildPolicy(source, overrides?)` reads env through the schema, validates every knob and rule, and returns a deep-frozen typed `Policy`. On any violation it throws `PolicyValidationError` listing **every** bad key (never the raw value — the env also holds secrets). `getPolicy()` is the memoised process policy. |
| Module | `apps/api/src/config/policy/policy.module.ts` | Global `PolicyModule` provides the same object as `POLICY`; imported first in `app.module.ts`, so a bad value fails startup. |
| Consumers | services | Classes that used to read `ConfigService` inject `@Inject(POLICY) policy: Policy`. Decorator arguments (`@Throttle`, `@Cron`, `@Interval`, BullMQ concurrency) and plain functions read `getPolicy()`. No service reads a knob env var directly any more. |
| Clients | `apps/web/src/config/policy.ts`, `apps/driver-app/lib/core/config/policy.dart` | One annotated const block each. Server-owned values come from API responses (quote fare, offer `ttlMs`, ride/pool snapshots); `server-mirror` rows copy a server rule the client cannot read. |
| Generator | `scripts/policy-doc.ts` (`pnpm policy:doc`) | Renders `docs/POLICY.md` and the commented policy block of `infra/docker/env.example/api.env.example`. |
| Drift check | `pnpm policy:doc:check` | Fails if either generated file is stale. Runs in `pnpm verify` and the Jenkins lint stage. |

Pure infrastructure (DB/Redis URLs, secrets, ports, CORS origins, the `RCAB_DISABLE_*` test seams) is **not** policy; it stays in `common/guards/auth-config.ts` and the infra modules (see [[secrets-management]]).

## Changing a business rule

1. Find the knob in `docs/POLICY.md`.
2. All environments: edit `default` (and `decision`, with the date and who decided) in `policy.schema.ts`. One deployment: set the env var.
3. `pnpm policy:doc` and commit the regenerated files; `pnpm verify`.
4. If a client mirrors it (`server-mirror`), update that client const too.
5. Product-visible changes (fares, windows) are owner decisions: record them in the story and consult [[hitl-touchpoints]].

Tests build policies with `buildPolicy({ ENV_NAME: 'value' })` or `defaultPolicy({ category: { knob: value } })` and pass them to constructors.

## See also
- [[nestjs-structure]] · [[module-dispatch]] · [[module-matching]] · [[module-rides]] · [[module-auth]]
- [[features-top-k-dispatch]] · [[features-scheduled-booking]] · [[features-shared-rides]]
