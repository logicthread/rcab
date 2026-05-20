---
title: Vision
tags: [layer/product, kind/moc]
status: accepted
phase: both
depends_on:
related: [[personas-client]], [[personas-driver]], [[phase-0]]
audience: both
---

# Vision

*A ride-hailing app for tier‑2 and tier‑3 Indian cities, built around shared rides on common routes.*

## Why this exists

In tier‑2/3 Indian cities, the dominant ride pattern isn't door-to-door at any-time — it's **predictable corridors** (e.g., suburb → market, college → station) at predictable times. Existing national apps optimize for metros: solo rides at premium pricing. The local equivalent is shared autos that physically queue at a stand.

**rcab moves the stand online**: a client opens the app, picks pick/drop, and either joins a shared ride already heading that way or starts a new one. Drivers serve more passengers per trip; clients pay less; the app earns from volume.

Normal solo rides and scheduled bookings are also supported — they are the fallback when sharing doesn't fit, not the headline.

## Non-goals (Phase-0)

- No iOS-native client app (web PWA covers it).
- No surge pricing.
- No payments integration in the first cut — cash on completion. Payments are a Phase-1 concern.
- No multi-city operations control plane — a single city configuration is hardcoded.

## What success looks like (Phase-0)

- 5,000 onboarded clients, 100 active drivers in one pilot city.
- ≥40% of rides served as shared rides.
- p95 dispatch latency (request → first driver notified) ≤ 3 s.
- Driver app uptime ≥ 99.5% over a 30-day window.

## Principles

1. **Low-bandwidth first** — every page must be usable on a 3G connection with a low-end Android browser.
2. **Drivers are the scarce resource** — the system must never burn a driver's attention on a bad match.
3. **The vault is the architecture** — see [[LLM-INSTRUCTIONS]]. We build the map before the territory.
4. **OSM for users, Google for drivers** — see [[ADR-0004-osm-for-booking-google-for-nav]]. Map UX for clients uses open tiles; drivers get the best turn-by-turn we can hand them.

## See also
- [[personas-client]] · [[personas-driver]]
- [[features-shared-rides]] · [[features-normal-booking]] · [[features-scheduled-booking]]
- [[phase-0]] · [[phase-1]]
