---
title: Feature — Shared rides
tags: [layer/product, kind/feature]
status: accepted
phase: 0
depends_on: [[vision]], [[personas-client]]
related: [[features-normal-booking]], [[algo-shared-ride-matching]], [[algo-route-similarity]], [[entity-shared-ride]], [[sm-shared-ride-pool]], [[journey-client-book-shared]]
audience: both
---

# Shared rides

*Pool multiple ride requests whose origin/destination corridors are similar enough to a route that an active or about-to-start ride is already serving.*

The headline feature. Phase-0 ships with this on by default — the booking UI starts on "Share" and the client can switch to "Solo" if they want a normal ride.

## Why this is hard

We do not have a sparse list of fixed routes. Routes emerge from demand. The matching algorithm must:

1. Decide if two ride requests are "on the same route" — see [[algo-route-similarity]].
2. Avoid making the driver detour too far. We define an acceptable detour budget per shared ride.
3. Time-bound the wait — a client doesn't want to be in a pool indefinitely while the system holds out for a co-rider.
4. Be fair to drivers (more passengers should mean more total payout).

## Rules of engagement (Phase-0)

- A new shared request first checks whether an **in-progress** or **about-to-start** shared ride exists whose route the new request fits within (origin-detour ≤ 800 m, destination-detour ≤ 800 m, route similarity ≥ 0.7).
- If yes, the request is **slotted** into that ride and the driver receives an update on their next pickup.
- If no, the request is **pooled** for 60 s, during which the system also dispatches to drivers. If another compatible request arrives, they share the same dispatch. If no co-rider arrives in 60 s, the request is either solo-dispatched as a normal ride or, with client consent, gets a longer pool window.
- Maximum pool size: 3 passengers (configurable).

See [[algo-shared-ride-matching]] for the precise algorithm and the role of [[entity-shared-ride]].

## Pricing (Phase-0)

A shared ride's fare per seat is the solo fare for that origin-destination, multiplied by `0.7` per occupant up to 2 seats; `0.55` per occupant at 3 seats. Driver receives the *sum* of seat fares minus platform commission. (Final numbers are placeholder — a config in [[secrets-management]].)

## See also
- [[features-normal-booking]] · [[features-scheduled-booking]]
- [[entity-shared-ride]] · [[sm-shared-ride-pool]]
- [[algo-shared-ride-matching]] · [[algo-route-similarity]]
- [[journey-client-book-shared]]
