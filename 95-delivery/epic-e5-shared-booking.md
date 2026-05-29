---
title: Epic E5 — Shared booking
tags: [layer/delivery, kind/epic]
status: living
phase: 0
epic_id: E5
demo: 4
depends_on: [[delivery-roadmap]]
related: [[features-shared-rides]], [[algo-shared-ride-matching]], [[algo-route-similarity]], [[module-matching]], [[sm-shared-ride-pool]], [[journey-client-book-shared]]
audience: both
---

# Epic E5 — Shared booking

*Demo 4: "Shared works"*

Pool open/grow/close, route similarity, multi-stop ride.

## Goal

Completing every story in this epic ⇒ Demo 4 passes.

## Stories

| ID | Title | Status |
|---|---|---|
| RCAB-E5.S1 | [[story-rcab-e5-s1-route-similarity-scorer]] — Route similarity scorer + cached OSRM polylines | ■ |
| RCAB-E5.S2 | [[story-rcab-e5-s2-matching-service-slot-vs-open]] — Matching service: slot vs. open decision | ■ |
| RCAB-E5.S3 | [[story-rcab-e5-s3-pool-lifecycle]] — Pool lifecycle (open → grow → close → start) | ■ |
| RCAB-E5.S4 | [[story-rcab-e5-s4-shared-ride-dispatch]] — Shared-ride dispatch (offer reflects pool span) | ■ |
| RCAB-E5.S5 | [[story-rcab-e5-s5-shared-ride-pricing]] — Shared-ride pricing per seat | ■ |
| RCAB-E5.S6 | [[story-rcab-e5-s6-web-booking-share-ui]] — Web booking UI — 'Share' default + pool-update events | ■ |
| RCAB-E5.S7 | [[story-rcab-e5-s7-driver-app-multi-stop]] — Driver app — multi-stop ride screen, per-passenger drop | ■ |

## Demo 4 headline (verbatim from [[delivery-roadmap]])

> Shared works

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[features-shared-rides]], [[algo-shared-ride-matching]], [[algo-route-similarity]], [[module-matching]], [[sm-shared-ride-pool]], [[journey-client-book-shared]]
