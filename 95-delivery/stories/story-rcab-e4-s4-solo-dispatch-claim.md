---
title: RCAB-E4.S4 — Dispatch — claim, revoke, wave-2, hard-fail (solo)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: m
hitl: yes
depends_on: [[story-rcab-e4-s3-dispatch-geo-candidates]], [[story-rcab-e4-s2-quote-request-endpoints]], [[algo-top-k-dispatch]], [[module-dispatch]]
affected_notes: [[algo-top-k-dispatch]], [[module-dispatch]]
owner: claude
audience: both
---

# RCAB-E4.S4 — Dispatch — claim, revoke, wave-2, hard-fail (solo)

## Goal

E4.S3 fans solo `ride_offer`s out to the nearest drivers, but no offer can be **won** yet: solo responses are tagged `offer:type='solo'` and skipped at response time, and the wave-2 + hard-fail BullMQ timers fire into handlers that no-op on a non-pool id. This story closes the solo dispatch loop — the **second half** of solo dispatch. When a driver accepts, atomically claim the ride first-accept-wins, bind it to that driver, revoke the losing offers; if nobody accepts in 30 s escalate to a wider wave 2; if nobody accepts in 60 s hard-fail the ride to `no_driver`. The shared-pool dispatcher (`claimPool` / `runWave` / `closePool`, E5.S4) keeps its behaviour unchanged.

## User-facing acceptance criteria

- `Given` a solo ride has outstanding offers, `When` a driver accepts, `Then` the ride is bound to exactly that driver (status `requested` → `accepted`), the winning driver is told they got it, and every other offered driver receives `ride_offer_revoked`.
- `Given` two drivers accept the same solo ride near-simultaneously, `When` both responses land, `Then` exactly **one** wins and the other gets a "ride already taken" rejection — never a double-assignment.
- `Given` no driver accepts within **30 s** (`DISPATCH_WAVE_ONE_TIMEOUT_MS`), `When` the wave-1 timer fires, `Then` wave 2 offers up to **K2 = 10** nearest drivers within **R2 = 4 km**, excluding everyone already offered.
- `Given` no driver accepts within **60 s** (`DISPATCH_HARD_FAIL_MS`), `When` the hard-fail timer fires, `Then` the ride is marked `no_driver`, any outstanding offers are revoked, and a `ride_no_driver` event is emitted for the client.
- `Given` a shared-ride pool, `When` it claims / times out / hard-fails, `Then` the existing shared flow is unchanged (no regression).

## Technical acceptance criteria

- **Migration 0007:** add `driver_id uuid` (nullable, FK `app_user(id)`) + `accepted_at timestamptz` to `rides`; index `rides_driver_idx`. The S2 `rides` table has no driver binding yet. *(J1)*
- **Atomic solo claim** `claimSolo(rideId, driverId)`: a single first-writer-wins decision (mechanism = **J1**), keyed **per `rideId`** (mirroring the pool's per-pool claim — *not* per-offer, else two drivers accepting their own offers would both win), then bind the winner in `rides` (`status='accepted'`, `driver_id`, `accepted_at`). Winner ⇒ proceed; already-claimed ⇒ rejection. The `accepted` `algo-top-k-dispatch` note (lines 45–61) specifies a Redis Lua atomic claim for this hot path.
- Wire the solo branch of `onRideOfferResponse` (`offer:type:<offerId> === 'solo'`, today an early return) to `claimSolo`: on win → `revokeAllOffers(rideId)` (reused) + emit accept-confirm to the winner + best-effort cancel the pending wave-2/hard-fail jobs; on loss → emit a rejection to that one driver only.
- `WaveTimeoutJob` + `HardFailJob` gain `kind: 'solo' | 'pool'`; `runSoloWave` schedules `kind:'solo'`, `runWave` schedules `kind:'pool'`. *(J2)*
- `handleWaveTimeout`: `kind === 'solo'` → load the `rides` row, no-op unless still `requested`, else `runSoloWave(ride, waveNumber)`; `kind === 'pool'` path unchanged.
- `handleHardFail`: `kind === 'solo'` → `UPDATE rides SET status='no_driver' WHERE id=$r AND status='requested'` + `revokeAllOffers(rideId)` + emit `ride_no_driver`; `kind === 'pool'` → existing `closePool(rideId,'aborted')` + revoke.
- Claim and both timer handlers are **status-guarded**, so a timer that fires after a successful claim is a safe no-op — timer cancellation is best-effort, not load-bearing. *(J3)*
- Reuse `revokeAllOffers`, the offer-key conventions, and `RealtimeBus.toDriver`; solo rideIds are distinct UUIDs so keys never collide with pool ids.

## Test plan

- **Unit (`DispatchService`):** solo claim winner path sets the row + emits `ride_offer_revoked` to losers + cancels timers; a second accept after the claim gets the rejection (no second winner); `handleWaveTimeout` (solo) runs `runSoloWave(ride, 2)` with K2/R2 and excludes already-offered drivers; `handleHardFail` (solo) sets `no_driver` + revokes + emits `ride_no_driver`. Pool claim / timeout / hard-fail tests still pass (regression).
- **Integration (Testcontainers, real PG + Redis):** seed a `rides` row `requested` + `active_drivers` geo entries; simulate an accept → `rides.status='accepted'`, `driver_id` set, offer keys cleared, a loser driver gets `ride_offer_revoked`; **concurrent double-accept** → exactly one row reaches `accepted`; fire the hard-fail job → `rides.status='no_driver'`.
- Driver/passenger fixtures via `/seed-db`; `/osrm-check` not required (claim is DB + Redis, not routing).

## HITL stops

1. **Demo-3 dispatch claim leg** — the "a driver accepts, the ride is theirs, the others lose it, and a no-driver request gives up cleanly" moment. Batched into the E4 end-to-end demo walk; sign off there.

## Out of scope

- Driver-side offer screen + accept/decline UI — RCAB-E4.S5 (this story is the backend the UI calls).
- Full ride state machine `accepted → en_route → arrived → in_progress → completed` — RCAB-E4.S6. S4 adds only the `requested → accepted` and `requested → no_driver` edges that dispatch itself needs.
- Client "searching / no driver" UI — RCAB-E4.S5 / web follow-up. S4 emits `ride_no_driver`; the UI consumes it later.
- Driver location stream after accept — RCAB-E4.S7.

## Notes / questions — to resolve at pickup

- **J1 — solo claim atomicity (headline):** (A) **Redis Lua atomic claim** keyed per `rideId` (`solo_claim.lua` mirroring `pool_claim.lua`, or a `SET claim:ride:<rideId> NX`), then write the winner to the `rides` row *(recommended — matches the `accepted` `algo-top-k-dispatch` note lines 45–61 and the E5.S4 `pool_claim.lua` precedent; keeps the DB out of the contention hot path)*; vs (B) Postgres conditional `UPDATE … WHERE status='requested'` *(simpler, one source of truth, but the algo note explicitly weighed and rejected this for the hot path — choosing it deviates from an `accepted` algorithm note → impact-analysis / ADR trigger, needs sign-off)*. **Both** still need **migration 0007** (`rides.driver_id` + `accepted_at`) to bind the winner.
- **J2 — solo vs pool in the shared timeout / hard-fail handlers:** (A) add `kind` to the job payload *(recommended — explicit; `runSoloWave` already schedules these jobs)*; vs (B) try `repo.findById` (pool) then fall back to `ridesRepo.findById` (solo).
- **J3 — timer cancellation on claim:** best-effort BullMQ job removal **plus** status-guarded handlers *(recommended)* vs treating job deletion as a hard requirement.

## See also

- [[epic-e4-normal-booking]] · [[journey-client-book-normal]] · [[algo-top-k-dispatch]] · [[module-dispatch]]
- [[story-rcab-e4-s3-dispatch-geo-candidates]] · [[story-rcab-e4-s2-quote-request-endpoints]]
