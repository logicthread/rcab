---
title: Epic E6 — Scheduled booking
tags: [layer/delivery, kind/epic]
status: living
phase: 0
epic_id: E6
demo: 5
depends_on: [[delivery-roadmap]]
related: [[features-scheduled-booking]], [[journey-client-book-scheduled]], [[redis-usage]]
audience: both
---

# Epic E6 — Scheduled booking

*Demo 5: "Scheduled works"*

BullMQ delayed jobs wake dispatch ahead of pickup.

## Goal

Completing every story in this epic ⇒ Demo 5 passes.

## Stories

| ID | Title | Status |
|---|---|---|
| RCAB-E6.S1 | [[story-rcab-e6-s1-bullmq-runner]] — BullMQ runner + Redis configuration | ■ |
| RCAB-E6.S2 | [[story-rcab-e6-s2-scheduled-request]] — type=scheduled flow at quote + request | ▶ |
| RCAB-E6.S3 | Wake-up worker → reuse normal dispatch path | · |
| RCAB-E6.S4 | Cancellation before/after wake | · |

## Demo 5 headline (verbatim from [[delivery-roadmap]])

> Scheduled works

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[features-scheduled-booking]], [[journey-client-book-scheduled]], [[redis-usage]]
