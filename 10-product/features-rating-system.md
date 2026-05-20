---
title: Feature — Rating system (two-sided)
tags: [layer/product, kind/feature]
status: accepted
phase: 0
depends_on: [[vision]]
related: [[entity-rating]], [[algo-rating-aggregation]]
audience: both
---

# Two-sided rating

*Both parties rate each other after a ride. Used for matching once enough data exists.*

## Rules (Phase-0)

- After ride completion, both client and driver are prompted to rate 1–5 stars (optional text feedback).
- A user's displayed rating is the **weighted mean** of their last N=50 ratings, with cold-start handling — see [[algo-rating-aggregation]].
- Ratings below 3 surface in a moderation queue (Phase-0: just a DB view).
- A user with < 5 ratings is shown as "New" — no number displayed.

## Effect on matching

- **Phase-0:** rating *does not* affect dispatch order. Recorded but advisory only.
- **Phase-1 (gated by sufficient data):** dispatch ranking will blend `distance × ETA × rating_compat` — see [[algo-top-k-dispatch]] §Future.

## See also
- [[entity-rating]] · [[algo-rating-aggregation]]
- [[features-history-dashboard]]
