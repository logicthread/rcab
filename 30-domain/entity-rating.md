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

## See also
- [[features-rating-system]] · [[algo-rating-aggregation]]
- [[entity-user]] · [[entity-ride]]
