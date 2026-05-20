---
title: Feature — Top-K dispatch
tags: [layer/product, kind/feature]
status: accepted
phase: 0
depends_on: [[vision]]
related: [[algo-top-k-dispatch]], [[module-dispatch]], [[features-normal-booking]]
audience: both
---

# Top-K dispatch

*When a booking is placed, the K nearest available drivers are notified in parallel; the first to accept wins.*

This is a **feature note** describing the product behavior. The algorithm details — distance metric, wave timing, fallback, future ranking blend — live in [[algo-top-k-dispatch]].

## Why top-K and not single-best

In tier-2/3 cities a single "nearest" driver is often slow to respond (different work patterns, multi-app usage, idle in a tea stall). Top-K trades a small amount of driver attention for dramatically faster acceptance.

## Phase-0 parameters

| Parameter | Value |
|---|---|
| K (initial wave) | 5 |
| K (wave 2, +30s) | 10 |
| Max radius | 4 km |
| Per-driver offer TTL | 12 s |
| Hard fail after | 60 s |

## See also
- [[algo-top-k-dispatch]] · [[module-dispatch]]
- [[features-normal-booking]] · [[features-shared-rides]]
