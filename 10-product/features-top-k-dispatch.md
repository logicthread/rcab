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
| Drivers offered per wave (K) | 20 |
| Wave 1 (start) radius | 3 km |
| Wave 2 (+30 s) radius | 5 km |
| Wave 3 (+45 s) radius = max | 7 km |
| Per-driver offer TTL | 12 s |
| Hard fail after | 60 s |

Owner decision 2026-11-18 ([[story-rcab-e8-s23-dispatch-three-waves]]): three widening waves instead of two, 20 drivers each. Values live in the policy table (`docs/POLICY.md`).

## See also
- [[algo-top-k-dispatch]] · [[module-dispatch]]
- [[features-normal-booking]] · [[features-shared-rides]]
