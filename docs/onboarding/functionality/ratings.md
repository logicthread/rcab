# Ratings

Two-sided star ratings after a completed solo ride. Phase-0 ships **capture only**: ratings are stored and validated, but nothing aggregates them, shows an average, or uses them in dispatch. Aggregation, moderation and the "New" cold-start display are Epic E7 (not started).

Back to [README](../README.md) · see also [normal-booking](normal-booking.md), [ride-lifecycle-cancel-no-show](ride-lifecycle-cancel-no-show.md) · product spec: `10-product/features-rating-system.md`, `30-domain/entity-rating.md`.

## What it does

After a ride reaches `completed`, either party can rate the other once:

- the **passenger** rates the **bound driver**;
- the **driver** rates the **passenger**.

The direction is inferred from the caller's identity (the body carries only stars and text). The same direction can be submitted once; a second attempt is a 409.

## User-visible behaviour

| Who | Behaviour | Video |
|---|---|---|
| Passenger (web) | When the tracking panel reaches "Trip complete" a card appears: five stars, optional comment (max 1000 characters), **Submit rating** (disabled until a star is chosen) and **Skip**. After submit or skip the card is replaced by "Thanks for rating!" | W03 |
| Driver (app) | After `end_ride` the app routes to `/rating/:id` ("Rate this ride", "How was your trip?", stars, optional text, Submit, Skip). A 409 from the API is treated as success (already rated) | D04 |

No rating prompt appears for cancelled, no-driver or no-show rides, nor for shared trips. Scene IDs: [W03](../videos/web/INDEX.md), [D04](../videos/driver-app/INDEX.md).

## API

`POST /v1/rides/:id/ratings` (any authenticated client or driver), body:

```json
{ "stars": 5, "text": "smooth ride" }
```

- `stars`: integer 1 to 5 (400 otherwise); `text`: optional string up to 1000 chars.
- 201 `{ id, rideId, subjectId, stars }`.
- 404 `ride_not_found`; 403 `forbidden` (caller is neither the passenger nor the driver of that ride); 409 `ride_not_completed`; 409 `already_rated`.

`RatingService.rate` loads the ride, requires `status = 'completed'`, resolves the subject as the other party (a completed ride always has a driver), and inserts with `ON CONFLICT DO NOTHING` on `(ride_id, rater_id, subject_id)`; zero rows inserted means `already_rated`.

## Data

`ratings` (`id`, `ride_id`, `rater_id`, `subject_id`, `stars` 1 to 5 CHECK, `text`, `created_at`; UNIQUE `(ride_id, rater_id, subject_id)`; CHECK rater different from subject; index on `(subject_id, created_at)`), migration 0010. `ride_id`, `rater_id` and `subject_id` are plain UUIDs without foreign keys. `client.rating_avg/rating_count` and `driver.rating_avg/rating_count/total_rides` exist in the schema but **nothing writes them**.

Ad-hoc check: `SELECT subject_id, round(avg(stars),2), count(*) FROM ratings GROUP BY 1;`

## Policy knobs

None on the server. Web mirror: `booking.ratingCommentMaxLength` = 1000 ([Client knobs](../../POLICY.md#web)); the server DTO re-validates the limit.

## Code entry points

API: `modules/rating/{rating.controller,rating.service,rating.repository,rating.module}.ts`, `dto/create-rating.dto.ts`. Web: `app/book/ride-tracking-panel.tsx` (`RatingCard`), `lib/booking/api.ts` (`submitRating`), `store.ts` (`rated`, `markRated`). Driver app: `features/rating/{rating_screen,rating_provider}.dart`.

## Tests

API: `rating.service.spec.ts`, `rating.controller.spec.ts`, `dto/create-rating.dto.spec.ts`; integration `rating.int.spec.ts`. Web: `ride-tracking-panel.test.tsx`, `lib/booking/api.test.ts`. Driver app: `test/features/rating/`.

## Known gaps

- **Solo rides only.** A shared trip's id is a pool id, which `RatingService` looks up in `rides` and answers 404.
- **No aggregation, display or use** (E7.S1, E7.S2): no average on profiles, no moderation view, no effect on dispatch.
- The `rated` flag on the web is in memory; after a reload a completed ride is not restored, so an unrated completed ride cannot be rated later from the UI. The API itself has no time limit.
- The driver app swallows every HTTP 409 as success, including `ride_not_completed`.
- Comments are stored as plain text without moderation or profanity filtering.
