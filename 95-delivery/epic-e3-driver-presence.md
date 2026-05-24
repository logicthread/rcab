---
title: Epic E3 — Driver presence
tags: [layer/delivery, kind/epic]
status: living
phase: 0
epic_id: E3
demo: 2
depends_on: [[delivery-roadmap]]
related: [[driver-flutter-structure]], [[driver-background-location]], [[journey-driver-go-online]], [[sm-driver-availability]], [[redis-usage]]
audience: both
---

# Epic E3 — Driver presence

*Demo 2: "The driver is online"*

Driver app shell + go-online + Redis geo index + location stream.

## Goal

Completing every story in this epic ⇒ Demo 2 passes.

## Stories

| ID | Title | Status |
|---|---|---|
| RCAB-E3.S1 | Flutter app skeleton: routing, theme, Riverpod, dio + refresh | · |
| RCAB-E3.S2 | Firebase OTP in Flutter | · |
| RCAB-E3.S3 | Vehicle registration screen + API | · |
| RCAB-E3.S4 | Online / offline toggle + foreground service | · |
| RCAB-E3.S5 | Location streaming (WS) + Redis GEOADD | · |
| RCAB-E3.S6 | OEM-kill mitigation onboarding | · |

## Demo 2 headline (verbatim from [[delivery-roadmap]])

> The driver is online

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[driver-flutter-structure]], [[driver-background-location]], [[journey-driver-go-online]], [[sm-driver-availability]], [[redis-usage]]
