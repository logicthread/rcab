---
title: RCAB-E4.S3 — Dispatch — geo candidate selection + offer fan-out (solo)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: m
hitl: yes
depends_on: [[story-rcab-e4-s2-quote-request-endpoints]], [[journey-client-book-normal]], [[algo-top-k-dispatch]], [[module-dispatch]]
affected_notes: [[algo-top-k-dispatch]], [[module-dispatch]]
owner: claude
audience: both
---

# RCAB-E4.S3 — Dispatch — geo candidate selection + offer fan-out (solo)

## Goal

A solo ride persisted `requested` (E4.S2) has no driver yet. This story is the **first half of solo dispatch**: when a request lands, select the nearest available drivers (top-K geo query against the Redis driver index) and fan out time-boxed `ride_offer`s to them. The **second half** — atomic first-accept-wins claim, revoking the losers, wave-2 escalation, and the 60 s hard-fail — is RCAB-E4.S4. The shared-ride dispatcher (`DispatchService`, RCAB-E5.S4) already does all of this for pools; this story adds the solo path **without disturbing the shared one**.

## User-facing acceptance criteria

- `Given` a client's ride is `requested`, `When` dispatch runs, `Then` up to **K1 = 5** nearest online drivers within **R1 = 2 km** of the pickup each receive a `ride_offer` (pickup, dropoff, fare, **12 s** TTL) on their driver channel.
- `Given` a driver has already been offered this ride, `When` a later wave runs, `Then` they are not offered it again.
- `Given` no online driver is within range, `When` wave 1 finds zero candidates, `Then` the wave-2 + hard-fail timers are still scheduled (their handling is E4.S4) and nothing crashes.
- `Given` a shared-ride pool closes, `When` it dispatches, `Then` the existing shared flow is unchanged (no regression).

## Technical acceptance criteria

- **Trigger:** `createNormal` (E4.S2) emits a `ride.requested` event after persisting; `DispatchService` consumes it (`@OnEvent`) and runs solo dispatch — mirroring the existing `pool.closed → dispatchPool` pattern. *(mechanism = J2)*
- `dispatchSolo(rideId)`: load the `rides` row; skip if not `requested` / already claimed; run wave 1.
- **Candidate selection:** `GEORADIUS active_drivers <pickup> <R> ASC COUNT k+seen`, drop already-offered, take top-K. *(reuse vs. parallel vs. new module = J1)*
- **Offer fan-out:** per candidate reserve `offer:<offerId>` (`NX`, 12 s), record `offer:list:<rideId>` + offered-set + `offer:meta:<offerId>=rideId`, tag `offer:type:<offerId>='solo'`, and emit `ride_offer` with a `SoloRideOfferPayload` `{ offerId, rideId, ttlMs, pickup, dropoff, fareCents, waveNumber }`.
- Schedule the wave-2 (`DISPATCH_WAVE_ONE_TIMEOUT_MS`, 30 s) + hard-fail (`DISPATCH_HARD_FAIL_MS`, 60 s) BullMQ jobs; **handlers land in E4.S4**.
- `onRideOfferResponse` must **not** route a solo offer into `claimPool` (the pool Lua) — solo offers (`offer:type='solo'`) defer their claim to E4.S4 (replaces the existing `solo path TODO` log line).
- Reuse the shared offer-key conventions + `RealtimeBus.toDriver`; rideIds are distinct UUIDs so keys don't collide.

## Test plan

- **Unit (`DispatchService`):** `dispatchSolo` selects top-K from a mocked `georadius`, reserves offers + emits `ride_offer` per candidate, excludes already-offered drivers, schedules wave-2 + hard-fail jobs. Shared `dispatchPool`/`runWave` tests still pass (regression).
- **Integration (Testcontainers, real Redis):** seed `active_drivers` geo entries; `dispatchSolo` records `offer:*` keys, the offered set, and `offer:meta`; a driver outside R1 gets no offer.
- Driver fixtures via `/seed-db`; `/osrm-check` not required (dispatch is geo + Redis, not routing).

## HITL stops

1. **Demo-3 dispatch leg** — part of the batched E4 end-to-end demo walk (offer reaches a driver). Sign off there.

## Out of scope

- Claim / revoke / wave-2 handling / hard-fail → `no_driver` — RCAB-E4.S4.
- Driver-side offer screen + accept/decline UI — RCAB-E4.S5.
- Client "searching for a driver" UI — RCAB-E4.S5 / web follow-up.

## Notes / questions — resolved 2026-05-30

- **J1 → (A)** extract private `selectCandidates()` + `emitOffer()` helpers shared by the pool and solo paths; add `dispatchSolo`/`runSoloWave` in `DispatchService`. Shared `runWave` keeps using them; its behaviour is unchanged.
- **J2 → `ride.requested` event** (EventEmitter2), mirroring `pool.closed → dispatchPool`. `createNormal` emits it after persist.
- **J3 → tag solo offers (`offer:type:<offerId>='solo'`) in S3** so `onRideOfferResponse` skips the pool claim for them (replaces the existing TODO log); the real solo claim lands in E4.S4.

## See also

- [[epic-e4-normal-booking]] · [[journey-client-book-normal]] · [[algo-top-k-dispatch]] · [[module-dispatch]]
- [[story-rcab-e4-s2-quote-request-endpoints]]
