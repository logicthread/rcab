---
title: Epic E4 — Normal booking
tags: [layer/delivery, kind/epic]
status: living
phase: 0
epic_id: E4
demo: 3
depends_on: [[delivery-roadmap]]
related: [[features-normal-booking]], [[algo-top-k-dispatch]], [[module-dispatch]], [[module-rides]], [[sm-ride-lifecycle]], [[journey-client-book-normal]], [[journey-driver-accept-ride]]
audience: both
---

# Epic E4 — Normal booking

*Demo 3: "Book a normal ride"*

OSM picker, quote, request, top-K dispatch, ride lifecycle, rating.

## Goal

Completing every story in this epic ⇒ Demo 3 passes.

## Stories

| ID | Title | Status |
|---|---|---|
| RCAB-E4.S1 | [[story-rcab-e4-s1-web-booking-screen]] — Web booking screen (Leaflet pick/drop, Nominatim, OSRM quote) | ■ |
| RCAB-E4.S2 | [[story-rcab-e4-s2-quote-request-endpoints]] — Quote + request endpoints with idempotency | ■ |
| RCAB-E4.S3 | [[story-rcab-e4-s3-dispatch-geo-candidates]] — Dispatch — geo candidate selection + offer fan-out | ■ |
| RCAB-E4.S4 | [[story-rcab-e4-s4-solo-dispatch-claim]] — Dispatch — claim, revoke, wave-2, hard-fail | ■ |
| RCAB-E4.S5 | [[story-rcab-e4-s5-driver-offer-screen]] — Driver offer screen + accept/decline | ■ |
| RCAB-E4.S6 | [[story-rcab-e4-s6-ride-state-machine]] — Ride state machine (solo: accepted → en_route → arrived → in_progress → completed) | ■ |
| RCAB-E4.S7 | Driver location stream → client WS (1 Hz throttle) | · |
| RCAB-E4.S8 | Cancellation paths (client & driver, fee tiers) | · |
| RCAB-E4.S9 | Rating prompts post-completion | · |

## Demo 3 headline (verbatim from [[delivery-roadmap]])

> Book a normal ride

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[features-normal-booking]], [[algo-top-k-dispatch]], [[module-dispatch]], [[module-rides]], [[sm-ride-lifecycle]], [[journey-client-book-normal]], [[journey-driver-accept-ride]]
