---
title: Algorithm — Rating aggregation
tags: [layer/algorithm, kind/algo]
status: accepted
phase: 0
depends_on: [[entity-rating]]
related: [[features-rating-system]]
audience: both
---

# Rating aggregation

*Weighted recency-biased mean with cold-start handling.*

## Update rule

When a new rating arrives for `subject_id`:

```
weights  : w_i = exp(-Δt_i / τ)              # τ = 30 days
trimmed  : drop top 5% and bottom 5% of last 50
display  : weighted mean of trimmed last 50
cold-start: if rating_count < 5 → show "New" (not a number)
```

We persist `rating_avg` and `rating_count` on the user row, but the **trimmed weighted mean** is recomputed periodically (nightly job + on every insert for small N) — not by maintaining incremental statistics. At our scale, recomputing over N≤50 is trivial.

## Why trimming

A single 1-star from a hostile counterparty (or a stray 5-star from a friend) should not move the score noticeably. Trimming top/bottom 5% mitigates this without needing manual moderation.

## Why exp recency

A driver with brilliant ratings two years ago and recent slips should reflect the slip. The decay constant τ=30d gives a smooth half-life.

## What about ties?

In Phase-0 ratings only inform a future ranking change (see [[algo-top-k-dispatch]] §Future). Tie-breaking isn't critical until that's live.

## See also
- [[entity-rating]] · [[features-rating-system]]
- [[algo-top-k-dispatch]]
