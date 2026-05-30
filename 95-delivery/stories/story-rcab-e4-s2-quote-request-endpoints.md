---
title: RCAB-E4.S2 — Quote + request endpoints with idempotency
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: m
hitl: yes
depends_on: [[story-rcab-e4-s1-web-booking-screen]], [[journey-client-book-normal]], [[features-normal-booking]]
affected_notes: [[journey-client-book-normal]], [[features-normal-booking]]
owner: claude
audience: both
---

# RCAB-E4.S2 — Quote + request endpoints with idempotency

## Goal

E4.S1 gave the client a live quote (fare + ETA + route geometry). This story lets the client **commit** that quote into a solo ride request. Today `POST /v1/rides` returns `NotImplementedException ("see RCAB-E4.S2")` for any non-shared type — this story adds the `type=normal` path: validate, dedup, persist a ride in a `requested` state, and return its id. The `POST /v1/rides/quote` endpoint now issues a **short-lived signed quote token** (5-min validity, fare + route locked in); the request must present a valid, unexpired token so the fare the client saw is the fare that's committed. The request must be **idempotent** so a double-tap or network retry never creates two rides. Actual driver dispatch (offer fan-out) is owned by RCAB-E4.S3; this story stops at a persisted, dispatch-ready request and the handoff to it. Do **not** break the existing shared path.

## User-facing acceptance criteria

- `Given` a client has a quote, `When` they confirm the booking (`POST /v1/rides`, `type=normal`, with an idempotency key), `Then` a ride is created in `requested` state and `{ rideId, status }` is returned.
- `Given` the same request is retried with the **same idempotency key** (double-tap / network retry), `When` it reaches the server, `Then` the original ride is returned and **no duplicate** is created.
- `Given` a quote token older than its 5-min validity window (per [[features-normal-booking]]), `When` the client requests, `Then` the server rejects with a `quote_expired` re-quote-required error (no stale fare committed).
- `Given` a tampered or missing quote token, `When` the client requests `type=normal`, `Then` the server rejects with `invalid_quote` / `400`.
- `Given` a non-client caller (driver), `When` they POST a request, `Then` `403 forbidden`.
- `Given` `type=scheduled`, `When` requested, `Then` `501 not_implemented` (E6) — unchanged.
- `Given` the existing shared (`type=shared`) flow, `When` exercised, `Then` it behaves exactly as before (no regression).

## Technical acceptance criteria

- **Quote token (`POST /v1/rides/quote`):** alongside the existing fields, the response gains `quoteToken` — a signed token (HMAC via the existing JwtService or a dedicated secret) encoding `{ originLat, originLng, destLat, destLng, soloFareCents, distanceM, durationS, iat, exp }`, 5-min expiry. Stateless; no new table.
- **`POST /v1/rides` `type=normal`:** `assertClient`, validate `CreateRideDto` (now carries `quoteToken`), verify the token (signature + not expired + coords match), persist a solo ride with the **fare locked from the token**, return `{ rideId, status: 'requested', passengerId, fare }`.
- **`rides` table (migration 0006):** `id` (uuid pk), `passenger_id` (fk app_user), `origin_lat/lng`, `dest_lat/lng`, `fare_cents`, `status` (`requested` …), `idempotency_key` (unique), `created_at`, `updated_at`. E4.S6 extends with state-machine columns/transitions.
- **Idempotency:** `Idempotency-Key` header (client UUID) required for create. Redis `idem:rides:<key>` → rideId (24 h TTL) for fast replay; `rides.idempotency_key` UNIQUE as the durable backstop. Same key → same ride, single insert.
- **Dispatch handoff:** create persists `status='requested'` and returns; E4.S3 owns the dispatch trigger (honours the existing `TODO(RCAB-E4.S3)`).
- Shared path (`findOrCreatePool`) untouched.

## Test plan

- **Unit (controller):** `type=normal` create returns `requested`; non-client → 403; `type=scheduled` → 501; shared path still routes to matching (regression).
- **Unit (idempotency):** same key → same ride id, single persist call; different key → distinct rides.
- **Integration (Testcontainers, real PG + Redis):** POST create persists a row; replay with same `Idempotency-Key` returns the same row and does not insert twice; expired-quote rejection (if Q3 in scope).
- Load: n/a (dispatch load is E4.S3/S4).

## HITL stops

1. **Schema decision** — if Q1 resolves to a new `rides` table, that is a migration (0006). Review before applying.
2. **Demo-3 booking flow** — this endpoint is on the critical booking path; covered by the batched E4 end-to-end demo walk (with E5.S7).

## Out of scope

- Driver candidate selection + offer fan-out — RCAB-E4.S3.
- The full ride state machine (`en_route → arrived → …`) — RCAB-E4.S6; this story only writes the initial `requested` state.
- Cancellation — E4.S8.

## Notes / questions — resolved 2026-05-30

- **Q1 persistence → new `rides` table (migration 0006).** Solo rides get a dedicated table; E4.S6 extends it with the full state machine. Pulled forward from E4.S6 because S2 needs durable persistence.
- **Q2 idempotency → `Idempotency-Key` header + Redis (`idem:rides:<key>`, 24 h TTL) + `rides.idempotency_key` UNIQUE backstop.**
- **Q3 quote validity → enforce 5-min now** via a signed `quoteToken` issued by the quote endpoint and verified on create; fare is locked from the token.
- **Q4 dispatch handoff → persist `status='requested'`; E4.S3 owns the trigger** (honours `TODO(RCAB-E4.S3)`).

## See also

- [[epic-e4-normal-booking]] · [[journey-client-book-normal]] · [[features-normal-booking]]
- [[story-rcab-e4-s1-web-booking-screen]]
