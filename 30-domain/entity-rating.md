---
title: Entity — Rating
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[entity-user]], [[entity-ride]]
related: [[features-rating-system]], [[algo-rating-aggregation]]
audience: both
---

# Rating

*One row per direction per ride per pair.*

## Fields

| Field | Type | Notes |
|---|---|---|
| id | uuid (v7) | pk |
| ride_id | uuid | fk |
| rater_id | uuid | fk → user.id |
| subject_id | uuid | fk → user.id |
| stars | smallint | 1..5 |
| text | text | nullable |
| created_at | timestamptz | |

## Invariants

- `rater_id != subject_id`.
- Unique on `(ride_id, rater_id, subject_id)` — you can rate the other party once per ride.
- Stars are 1–5. Anything outside is a 400 at the API.

## Aggregation

`user.rating_avg` and `user.rating_count` are denormalized for fast reads. They are updated **transactionally** when a rating is inserted using [[algo-rating-aggregation]]'s weighted scheme.

## As-built (RCAB-E4.S9)

> Capture shipped as the **`ratings`** table (plural) via **migration 0010**, matching the fields + invariants above: `stars` CHECK 1–5, UNIQUE `(ride_id, rater_id, subject_id)`, CHECK `rater_id <> subject_id`, index `(subject_id, created_at DESC)`. `ride_id` / `rater_id` / `subject_id` are **plain `uuid` (no cross-table FK)** — mirrors the shipped `rides.driver_id` convention and keeps capture decoupled from `app_user` / `rides` lifecycles. Inserted by `RatingService` only after the ride is `completed`; direction is resolved from the ride row.
>
> **Aggregation is deferred to E7:** `rating_avg` / `rating_count` denorm + the weighted-recency mean ([[algo-rating-aggregation]]) are **not** updated by E4.S9 — it writes raw rows only.

## See also
- [[features-rating-system]] · [[algo-rating-aggregation]]
- [[entity-user]] · [[entity-ride]]
