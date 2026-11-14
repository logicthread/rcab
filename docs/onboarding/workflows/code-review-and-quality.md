# Workflow: code review and quality

What "good enough to merge" means here, and the tools that check it. Gate commands are defined in
[testing.md](testing.md); the process around them is in [story-lifecycle.md](story-lifecycle.md).

## 1. Before you open a PR (author)

1. `/lint` — ESLint (zero warnings), `tsc --noEmit` for api and web, Dart analyzer for the driver app, Prettier
   check. `pnpm lint` is the CI subset (ESLint + `next lint`); CI additionally type-checks every package.
2. `pnpm verify` — lint, `policy:doc:check`, api coverage floor, Testcontainers integration. Green, not skipped
   (`RCAB_SKIP_INT=1` does not count).
3. Driver app touched: `flutter analyze` and `flutter test` (`/flutter-test all`).
4. Web behaviour changed: `/playwright-run` the relevant flow (a short recording helps reviewers).
5. `/coverage` if you added a lot of logic (quality gates: 80 % API / 70 % driver are the target in the skill; the
   enforced api floor is the vitest threshold).
6. Generated artefacts fresh: `pnpm policy:doc` (policy changes), `pnpm code:graph` (if `codegraph/.stale`).
7. Vault updated: every `affected_notes` entry of the story; no dangling `[[links]]` (the hook warns on edit,
   `/close-story` checks again). Add a stub note rather than leaving a dangling link.
8. Commit message with the `Story:` trailer ([story-lifecycle.md](story-lifecycle.md) section 4); small, reviewable
   commits; PR description states the story, what changed, what you did **not** do, and how you tested. If you picked
   between two reasonable libraries or fixtures, say which and why (soft stop in `hitl-touchpoints.md`).

## 2. Self-review with the skills

| Skill | Use |
|---|---|
| `/code-review [--fix]` | Review the current diff for correctness bugs and cleanups; `--fix` applies them |
| `/security-review` | Security review of pending changes |
| `/simplify` | Reuse / simplification pass on changed code |
| `/security-scan` | `npm audit` + secret scan + OWASP-pattern grep mapped onto the vault checklist (full tree, not a diff) |
| `/babysit-prs` | Poll your open PRs for CI state (`/loop 5m /babysit-prs`) |

## 3. What reviewers check (the rcab-specific list)

**Correctness under concurrency** (most defects here live in this category)
- Does a new state change take the trip row lock first (`SELECT … FOR UPDATE`) and follow the lock order
  trip row -> offer row -> assignment guard, `shared_rides` -> `pool_member`?
- Are post-commit effects (socket emit, Redis write, BullMQ add) strictly after commit and best effort?
- Is a new durable side effect written through the **outbox** in the same transaction, with a deterministic job id and
  a generation guard in the consumer?
- Is there a multi-connection test for anything two actors can race on?
- Does the work check `dispatch_generation`/state so a stale job or duplicate delivery is a no-op?

**Data**
- Migration additive, idempotent, readable by the previous release, mirrored in `schema.ts`, rehearsed if it rewrites
  data ([database-migrations.md](database-migrations.md)).
- Invariants expressed as constraints/triggers where possible; typed failure results rather than thrown strings.
- Money is integer paise; times are `timestamptz` on the DB clock for deadlines (offers use `clock_timestamp()`).

**API and contract**
- DTOs validated (`class-validator`, whitelist), error bodies `{code, message}` with a documented code, idempotency
  semantics on create endpoints, role checks on every driver-only/client-only route, ownership checks (a caller
  asking about someone else's ride gets 404/403 without existence leaks).
- Realtime payload changes are additive; clients gate on `version`; the snapshot path still heals a missed event.
- `rest-endpoints.md`, `websocket-events.md`, `error-codes.md` updated.

**Config**
- No new magic number: it is a policy knob with a `decision` ([business-config-changes.md](business-config-changes.md)).
- No secret in code, fixtures, logs or metrics labels.

**Clients**
- Web: no business rule duplicated that the server owns (only documented `server-mirror` knobs); every async effect
  is abortable; state resets on sign-out.
- Driver app: server outcomes are authoritative; no stop command enabled before an assigned outcome; timers injectable
  for tests; works against an api that has not shipped the matching change yet.

**Observability**
- New business event has a metric (low-cardinality labels only: never user, ride or request ids) and a log line with
  `request_id`; dashboards/alerts updated if it changes what "healthy" looks like.

**Docs**
- State-machine change reflected in [state-machines.md](../state-machines.md) and the vault `sm-*` note.
- Behaviour that surprised you while reading is documented where the next person will read it.

## 4. Security checklist

[`90-quality/security-checklist.md`](../../../90-quality/security-checklist.md) is the checklist (ticked items are
the ones already proven by RCAB-E8.S7: token rotation and family revocation, hashed refresh tokens, fail-closed prod
secrets/CORS, suspended-account handling, scoped idempotency keys). Highlights to keep true in review:

- Endpoints behind the auth guard except `/v1/auth/*` and `/v1/health/*`; role guards on role-specific routes.
- Tokens never logged; no PII (phone, email, name) in logs; `request_id` propagated.
- Web: no `dangerouslySetInnerHTML` with user-controlled content; CSP allow-list for OSM tiles and Firebase hosts.
- DTO bounds, body size cap, parameterised SQL only (Drizzle or `$n` placeholders — see `auth.service.ts`).
- Secrets: see `80-infrastructure/secrets-management.md`. **HITL: do not change secrets handling without the owner.**
- Open items on the checklist are real backlog, not noise; do not mark one done without evidence.

## 5. Static analysis and formatting

- ESLint flat config at `eslint.config.mjs`; Prettier; the api tsconfig is strict. Fix warnings, do not disable rules
  inline without a comment saying why.
- Dart: `apps/driver-app/analysis_options.yaml`.
- The coverage floor is a ratchet: raise it when you add tests, never lower it to merge.

## 6. Responding to review

- Verify a suggestion against the code before applying it; push back with evidence if it is wrong (the code wins over
  both the reviewer's memory and the vault).
- A review comment that changes acceptance criteria is a HITL stop (impact analysis), not a quick edit.
- Merge with `/merge-pr` (conflict handling, local cleanup). After merge the next story starts from a fresh
  `origin/main` via `/new-branch`.
