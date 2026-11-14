# Workflow: adding a feature end to end (worked example)

This page walks one realistic change through **every layer** — vault, database, API, realtime, web, driver app,
tests, docs — so you can copy the shape. The example is illustrative (it is not in the codebase); file names and
function names are real, so you can open each one.

> **Feature:** a rider can attach an optional *pickup note* ("Blue gate, opposite the pharmacy", max 140 chars) to a
> solo booking; the driver sees it on the offer screen and the ride screen.

Companion reading: [story-lifecycle.md](story-lifecycle.md) (process), [testing.md](testing.md),
[database-migrations.md](database-migrations.md), [business-config-changes.md](business-config-changes.md),
[state machines](../state-machines.md).

## 0. Decide whether this is one story, and orient

1. Is there a story? `95-delivery/stories-index.md`. If not: `/gen-story RCAB-E<n>.S<m> pickup-note`. Because this
   adds behaviour not in any current acceptance criteria, state it as a new story rather than widening another
   (a mid-flight AC change is a HITL stop, see `impact-analysis.md`).
2. `/pickup-story RCAB-E<n>.S<m>` loads the minimum notes. For booking work that is typically the reading path
   `path:implement-normal-booking`: `features-normal-booking`, `entity-ride`, `sm-ride-lifecycle`, `module-rides`,
   `module-dispatch`, `module-realtime`, `rest-endpoints`, `websocket-events`.
3. `/new-branch RCAB-E<n>.S<m>`; `/smoke-check` so you start from a healthy stack.
4. Navigate with the code graph instead of grepping: `/code-graph route POST /v1/rides`,
   `/code-graph importers apps/api/src/modules/rides/rides.repository.ts`.

Does it touch a state machine? No: the note does not change any status or transition, so
[state-machines.md](../state-machines.md) needs no new row. (If you add a status or event, update that page, the
`CHECK` constraint, the policy lists and the clients' status enums in the same PR.)

## 1. Database

`apps/api/migrations/0018_rides_pickup_note.sql` — additive, nullable, idempotent:

```sql
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_note text;
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_pickup_note_len_check;
ALTER TABLE rides ADD CONSTRAINT rides_pickup_note_len_check
  CHECK (pickup_note IS NULL OR char_length(pickup_note) <= 500);   -- hard ceiling; the real limit is policy
```

Mirror it in `apps/api/src/db/schema.ts` (`pickupNote: text('pickup_note')` and the `check`). Apply with
`npx tsx src/migrate.ts` in the api container. Rules and rehearsal: [database-migrations.md](database-migrations.md).

## 2. Business config (the 140)

The limit is a business decision, so it is a policy knob, not a literal in a DTO:
`rides.pickupNoteMaxLength` in `policy.schema.ts` (`int({env: 'RIDE_PICKUP_NOTE_MAX_LENGTH', default: 140, min: 1, max: 500, unit: 'chars', description, decision})`),
then `pnpm policy:doc`. The web and the driver app cannot read it at runtime, so add `server-mirror` entries to
`WEB_POLICY` + meta and `DriverPolicy` (the generator fails on a missing meta entry). See
[business-config-changes.md](business-config-changes.md).

## 3. API

| Concern | Where | Change |
|---|---|---|
| Input | `modules/rides/dto/create-ride.dto.ts` | `@IsOptional() @IsString() @MaxLength(500) pickupNote?: string`; enforce the policy limit in the controller and reject with 400 `pickup_note_too_long` (see the error style in `rides.controller.ts`) |
| Persistence | `modules/rides/rides.repository.ts#create` + `ride-row.ts` (`toRow`, `RideRow`) | add `pickupNote` to the insert values and the row mapper |
| Idempotency | `modules/rides/idempotency.ts#requestFingerprint` | **Decide deliberately.** The fingerprint is the *business intent* (operation, coordinates, scheduled instant). Leaving the note out means a retry that changes only the note silently replays the original ride; including it means the same key with a different note is 422 `idempotency_key_conflict`. Either is defensible; write the decision in the function's comment and test it |
| Read paths | `rides.controller.ts#rideDetail` (`GET /v1/rides/:id`) | include `pickupNote` for both parties |
| Authorisation | `GET /v1/rides/:id` already restricts to passenger and bound driver | the note is only ever returned there and in the offer to *offered* drivers |
| Offer payload | `modules/dispatch/dispatch.types.ts` (`SoloRideOfferPayload`) and `dispatch.service.ts#runSoloWave` | add `pickupNote?: string`; **additive only** — old driver builds ignore unknown fields, new builds must tolerate absence |
| Snapshot | `modules/realtime/realtime.protocol.ts` (`RideSnapshot`) and `realtime-snapshot.service.ts` | add the field if the driver's ride screen reads from the snapshot |
| Docs | vault `40-backend/rest-endpoints.md`, `websocket-events.md`, `schema-postgres.md`, `30-domain/entity-ride.md` | the notes in the story's `affected_notes` |

Things that do **not** change, and why you should check them anyway: the outbox (the create transaction already
writes the dispatch intent atomically — your new column rides along in the same insert), the driver exclusivity guard,
the ride state machine, the quote token (it locks fare + route, not free text).

## 4. Web (`apps/web`)

- `src/lib/booking/api.ts#createNormalRide` — add the optional `pickupNote` to the body; do not add it to the quote.
- `src/lib/booking/store.ts` — a `pickupNote` field plus setter; clear it in `reset()`; changing it must **not** call
  `clearQuote` (it does not affect the route or fare).
- `src/app/book/book-client.tsx` — a text input (private rides only) bounded by the mirrored limit; the intent key
  tracker (`createIntentKeyTracker`) is keyed by ride type + route, which is consistent with the fingerprint decision
  above.
- Tests: `store.test.ts`, `api.test.ts`, `book-client.test.tsx`; run `pnpm --filter @rcab/web test`.
- Record a Playwright scene or at least run `/playwright-run` to look at it in a browser.

## 5. Driver app (`apps/driver-app`)

- `lib/features/offer/offer_models.dart` — `SoloRideOffer.tryFromRideOfferJson`: parse `pickupNote` as optional.
- `lib/features/offer/offer_screen.dart` — show it under the pickup address when present.
- `lib/features/ride/ride_models.dart` (`RideDetail.fromJson`) and `ride_screen.dart` — show it on the active ride.
- Tests under `test/features/offer` and `test/features/ride`; `flutter test`.
- Remember the driver app is a separate release train (Android build, outside the pnpm workspace): the API change
  must work with a driver app that has not been updated.

## 6. Tests, in the order you should write them

1. API unit (`rides.controller.spec.ts`): accepted with a note, rejected over the limit, note absent unchanged.
2. Repository/SQL: `rides.repository` integration case in `test/integration/` proving the column persists and the
   CHECK rejects oversize text.
3. Idempotency: replay with the same key and note returns the original; behaviour for a changed note matches your
   decision (`rides.idempotency.spec.ts`, `rides-idempotency.int.spec.ts`).
4. Realtime: offer payload contains the note only for the offered driver (`dispatch-offer-gateway.int.spec.ts` style).
5. Web and driver unit tests (sections 4 and 5).
6. If two actors can touch the same row concurrently because of your change, add the **multi-connection** race test
   ([testing.md](testing.md) section 4). Here they cannot, so none is needed.
7. `pnpm verify` — the gate.

## 7. Docs, graph, review

- Update every note in the story's `affected_notes`; `validate-vault-links.sh` warns on dangling `[[links]]`.
- `pnpm code:graph` if `codegraph/.stale` appeared; `pnpm code:graph:check` flags vault/code module drift.
- `/lint`, then `/code-review` (and `/security-review`: a free-text field shown to another user is an injection and
  abuse surface — React/Flutter escape it, the DTO bounds it, but think about logs and metrics labels: never use the
  note as a Prometheus label). See [code-review-and-quality.md](code-review-and-quality.md).
- Commit with the trailer, e.g.:

```
feat(api): optional pickup note on solo rides

Adds rides.pickup_note (0018), a policy-bounded DTO field, the offer and ride-detail
payloads, plus web input and driver-app display.

Story: RCAB-E<n>.S<m>
```

- `/close-story`, then `/ship-story`. If the story ends an epic, the demo sign-off is a HITL stop.

## 8. The shape to remember

```
vault note -> story -> migration + schema.ts -> policy knob -> DTO/controller/repository -> realtime payload
           -> web store/api/UI -> driver model/screen -> unit + integration (+race) tests -> docs -> verify -> trailer
```

Anything that decides *whether a trip may change state* goes through the row-lock transactions described in
[state-machines.md](../state-machines.md); anything that must survive a crash between "committed" and "told someone"
goes through the outbox. If your feature needs either, read the Stage C contract
([`docs/remediation/stage-c-contract.md`](../../remediation/stage-c-contract.md)) first.
