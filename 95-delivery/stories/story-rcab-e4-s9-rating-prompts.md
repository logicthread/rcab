---
title: RCAB-E4.S9 — Rating prompts post-completion
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: m
hitl: yes
depends_on: [[story-rcab-e4-s6-ride-state-machine]], [[story-rcab-e4-s8-cancellation-paths]], [[entity-rating]], [[features-rating-system]], [[rest-endpoints]], [[driver-screens]], [[web-state-management]], [[schema-postgres]]
affected_notes: [[features-rating-system]], [[entity-rating]], [[rest-endpoints]], [[schema-postgres]], [[module-map]], [[nestjs-structure]], [[driver-screens]], [[web-state-management]], [[journey-client-book-normal]], [[algo-rating-aggregation]]
owner: claude
audience: both
---

# RCAB-E4.S9 — Rating prompts post-completion

## Goal

E4.S6 drives a solo ride to `completed`; on that transition the driver app already routes to `/rating/:id` and the web rider panel shows a "Trip complete" banner. But `/rating/:id` is a **stub** ("Rating UI lands in RCAB-E7.S1 — tap Done to return home") and the web side has **no rating affordance at all**. This is the **last story of E4** — the thing standing between the current build and a complete "Book a normal ride" demo, which should end with *both* parties able to rate the ride 1–5 stars.

This story makes the **two-sided rating prompt real and persistent** for solo `rides`: a star-and-text prompt on driver `/ride → /rating/:id` (replacing the stub) and an inline rating card in the web rider panel's completed state, both backed by a minimal **`POST /v1/rides/:id/ratings`** that writes one `ratings` row honoring the [[entity-rating]] invariants (stars 1–5, `rater_id != subject_id`, one rating per direction per ride, direction inferred from auth). The transport contract is already declared in [[rest-endpoints]] (`POST /v1/rides/:id/ratings` `{ stars, text }`) and the data model in [[entity-rating]]; this story builds them.

**What this story deliberately does *not* build is the rating *read* side.** The weighted-recency aggregation, the denormalized `user.rating_avg` / `rating_count`, the history page, the driver earnings dashboard, and the low-rating moderation view are all **Demo 6 / Epic E7** territory ([[algo-rating-aggregation]], [[features-history-dashboard]]). E4.S9 captures ratings correctly; E7 reads and aggregates them. This split is the headline judgment call (**J1**) — see Notes.

## User-facing acceptance criteria

- `Given` a client whose solo ride has just reached `completed`, `When` the web rider panel renders the completed state, `Then` it shows a **rating card** (1–5 stars, optional text, **Submit** + **Skip**) for rating the driver, alongside the "Book another ride" action.
- `Given` a driver whose ride reached `completed` (app routed to `/rating/:id`), `When` the rating screen renders, `Then` it shows a **real prompt** — 1–5 stars for the client, optional text, **Submit** + **Skip** — not the placeholder.
- `Given` either party has picked a star count, `When` they tap **Submit**, `Then` the rating is persisted, a brief acknowledgement is shown, and they land back on a sane next screen (driver → `/home`; web → "Book another ride" / fresh booking).
- `Given` either party taps **Skip**, `When` the prompt dismisses, `Then` no rating row is written and they reach the same next screen (rating is optional per [[features-rating-system]]).
- `Given` a party who already rated this ride, `When` they submit again, `Then` the API rejects the duplicate (HTTP 409 `already_rated`) and the UI treats the ride as already rated rather than erroring loudly.
- `Given` a ride that is **not** `completed` (still in-flight, or `cancelled` / `no_show`), `When` a rating is submitted, `Then` it is **rejected** (HTTP 409) — you can only rate a completed ride. (A cancelled / no-show ride never opens the prompt.)
- `Given` stars outside 1–5, `When` submitted, `Then` the API returns **400** and the UI keeps the prompt open.

## Technical acceptance criteria

### API (apps/api — new `rating` module)

- **`ratings` table — migration 0010.** Columns per [[entity-rating]]: `id uuid pk`, `ride_id uuid NOT NULL`, `rater_id uuid NOT NULL`, `subject_id uuid NOT NULL`, `stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5)`, `text text NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. **UNIQUE `(ride_id, rater_id, subject_id)`** + a `CHECK (rater_id <> subject_id)`. Index `(subject_id, created_at DESC)` for the E7 read side. Plain `uuid` ride_id (no cross-table FK — mirrors the `rides.driver_id` convention). Drizzle schema (`ratings`) added to match.
- **`RatingService.rate({ rideId, raterId, stars, text })`** — resolves the ride from `rides`, asserts `status = 'completed'` (→ `not_completed`), resolves **direction from the row**: if `raterId === passenger_id` the subject is `driver_id` (client → driver); if `raterId === driver_id` the subject is `passenger_id` (driver → client); anyone else → `not_a_party`. Inserts the row; a unique-violation surfaces as `already_rated`. Returns a discriminated result (`ok` | `not_found` | `not_a_party` | `not_completed` | `already_rated`). **No aggregation, no denorm write** (J1 / Out of scope).
- **`POST /v1/rides/:id/ratings`** (`AuthGuard`; both `client` and `driver`). Body `{ stars: 1..5, text?: string (maxlen) }` (`class-validator`; out-of-range → 400). Maps results: `ok` → **201** `{ id, rideId, subjectId, stars }`; `not_a_party` → **403**; `not_found` → **404**; `not_completed` / `already_rated` → **409** (distinct `code`s). Matches the [[rest-endpoints]] rating row (annotate it as shipped).
- **Module wiring** — new `RatingModule` (`RatingController` + `RatingService` + repository), registered in `app.module`. Endpoint nests under the rides path (`/v1/rides/:id/ratings`) but lives in its own module (matches [[module-map]]'s `rating` module + [[nestjs-structure]] `rating/`).

### Flutter (apps/driver-app — `/rating/:id`, replace the E5.S7 stub)

- **`RatingScreen`** becomes a real prompt: a 1–5 **star selector** (`Key('rating_stars')`, one tappable star per value), an optional multiline **text field**, a **Submit** button (`Key('rating_submit_button')`, disabled until a star is chosen) and a **Skip** (`Key('rating_skip_button')`). Keep `Key('rating_screen')`.
- **`RatingController` / `RatingService`** (new, mirrors `RideService` seam): `submit(rideId, stars, text)` → `POST /v1/rides/:id/ratings`. On success or skip → `context.go('/home')`; an `already_rated` 409 is treated as success (already rated). Errors keep the screen open with a retry.
- Drives **both** solo and shared completions (the screen is shared today) — but the **endpoint targets solo `rides`** this story; a shared-ride completion still reaches the prompt and may surface a graceful "rating unavailable for shared rides yet" path (J6).

### Web (apps/web — rider tracking panel, E4.S7/S8)

- **`RideTrackingPanel`** completed terminal state gains an inline **rating card**: stars (`data-testid="rating-stars"`), optional text, **Submit** (`data-testid="rating-submit"`) + **Skip**, shown alongside the existing "Book another ride". **No new `/rating` web route** — web rates in-place (consistent with E4.S7's "web tracks in-place, the `/ride` route is the driver app").
- **`api.ts`** — `submitRating(rideId, stars, text, jwt)` → `POST /v1/rides/:id/ratings`. **booking store / `book-client`** — a small `rated` flag (or local card state) so the card collapses to a thank-you after submit/skip; reuse the E4.S7 `onNewBooking` / `clearActiveRide` path.

### Vault reconciliation

- **[[rest-endpoints]]** — annotate `POST /v1/rides/:id/ratings` as shipped (201 / 400 / 403 / 404 / 409; direction inferred from auth; completed-only; one per direction).
- **[[entity-rating]]** — add an as-built note: the real `ratings` table (migration 0010), the unique key, the `rater_id <> subject_id` CHECK, and that **aggregation / denorm (`rating_avg`,`rating_count`) is deferred to E7** ([[algo-rating-aggregation]]).
- **[[schema-postgres]]** — the indicative DDL shows an abstract `rating` table; add an as-built note for the shipped `ratings` table + the columns/constraints 0010 created.
- **[[module-map]] / [[nestjs-structure]]** — mark the `rating` module as built (insert/capture only; aggregate is E7).
- **[[features-rating-system]]** — note the Phase-0 split: **capture ships in E4.S9 (Demo 3)**; the weighted-mean display, "New" (<5) badge, and moderation view ship in **E7 (Demo 6)**.
- **[[algo-rating-aggregation]]** — note that the aggregation consumer is not wired yet; E4.S9 only writes raw `ratings` rows for it to consume later.
- **[[driver-screens]]** — flesh `/rating/:id` from stub to the real star + text + submit/skip prompt.
- **[[web-state-management]]** — add the rating card state (`rated` flag / `submitRating` action) to the booking slice.
- **[[journey-client-book-normal]]** — add the closing rating leg (completed → rate driver → done).

## Test plan

- **Unit (API — `rating.service.spec.ts`):** client rates a completed ride → row with `subject = driver_id`; driver rates → `subject = passenger_id`; a non-party rater → `not_a_party`; rating a non-`completed` ride → `not_completed`; a second rating same direction → `already_rated`; `rater_id != subject_id` always holds.
- **Unit (API — `rating.controller.spec.ts`):** stars out of 1–5 → 400; result mapping to 201 / 403 / 404 / 409 with distinct codes; auth required.
- **Integration (API — Testcontainers postgres):** seed a real `rides` row at `completed`; client POST → 201 + persisted row (subject = driver), driver POST → 201 (subject = client); duplicate → 409; rating a `cancelled` ride → 409; the UNIQUE + CHECK constraints enforced at the DB. **Real containers, no infra mocks.**
- **Unit/Widget (Flutter):** `RatingScreen` — submit disabled until a star chosen; submit issues the right POST and routes `/home`; skip routes `/home` with no POST; a 409 `already_rated` is treated as done.
- **Web (RTL):** completed panel shows the rating card; choosing stars + submit calls `submitRating` and collapses to a thank-you; skip collapses without a call; "Book another ride" still works.
- Gate: `pnpm test` + `pnpm test:int` + `/flutter-test unit widget` + `/lint`.

## HITL stops

1. **Capture-vs-aggregate boundary (J1)** — confirm E4.S9 ships the rating *insert* (+ table + invariants) and that E7.S1 ("Rating insert endpoint + invariants") re-scopes to **aggregation + denorm + moderation** (E4.S9 delivers the insert E7.S1 named). This shifts a not-yet-started future story's scope → an [[impact-analysis]] note, surfaced at pickup. *(If the dev prefers a prompt-UI-only E4.S9 with submission deferred to E7.S1, say so at pickup and the endpoint/table drop from scope.)*
2. **Demo-3 rating leg** — "complete a ride, both sides rate." Batched into the E4 end-to-end demo walk and signed off there (as with E4.S5–S8; the live client↔driver walk is expected to defer to the first E4 end-to-end dry-run, covered by API integration + Flutter/RTL until then).

## Out of scope

- **Rating aggregation + denormalization.** The weighted-recency mean (last N=50), the transactional `user.rating_avg` / `rating_count` update ([[algo-rating-aggregation]]) → **E7.S2**.
- **Read surfaces.** Client ride history, driver earnings dashboard, any "your rating is X" display ([[features-history-dashboard]]) → **E7.S3/S4**.
- **Moderation + cold-start display.** Low-rating (<3) moderation view, the "New" badge for users with <5 ratings → **E7**.
- **Shared-ride rating.** The capture endpoint targets solo `rides` only; multi-passenger shared-ride rating (subject ambiguity across pool members) is deferred (E5/E7). The shared screen still opens but its submit path is gated (J6).
- **Editing / deleting a submitted rating; rating reminders / push.** One-shot optional prompt at completion only.
- **Rating after a cancel / no-show.** Only `completed` rides open the prompt (consistent with E4.S8 Out of scope).

## Notes / questions (resolve at pickup)

- **J1 — capture vs aggregate split (headline):** *lean* — ship the **insert endpoint + `ratings` table + invariants** here so the prompt actually persists (a non-saving prompt is a dead demo button); defer aggregation/denorm/dashboards to E7 and re-scope E7.S1 to aggregation. Alternative: prompt-UI-only, submission deferred to E7.S1 (keeps E7.S1 intact but ships a dead button). Needs the dev's call — it moves E7.S1's scope.
- **J2 — module placement:** *lean* — a new `RatingModule` mounting `/v1/rides/:id/ratings` (matches [[module-map]] `rating` + [[nestjs-structure]] `rating/`), over folding the endpoint into `RidesController`.
- **J3 — re-rate behavior:** *lean* — UNIQUE `(ride_id, rater_id, subject_id)` → second submit is **409 `already_rated`** (the UI treats it as done), over an upsert/edit. One-shot prompt; edit is out of scope.
- **J4 — skip semantics:** *lean* — Skip writes **no row** and navigates on (rating optional per [[features-rating-system]]).
- **J5 — web rating placement:** *lean* — an **inline card in the completed terminal panel** (no `/rating` web route; web rates in-place — consistent with E4.S7).
- **J6 — shared-ride completions:** *lean* — the shared `/rating/:id` opens but its submit is **gated to solo `rides`** this story; shared-ride rating deferred. Confirm the graceful path (hide submit / "not yet available") is acceptable for the shared screen.
- **Migration number:** next free is **0010** (0009 was E4.S8 cancellation).
- **Scope:** spans **API + web + Flutter** (like E4.S8) — one feature across three surfaces; kept whole.

## See also

- [[epic-e4-normal-booking]] · [[features-rating-system]] · [[entity-rating]] · [[algo-rating-aggregation]]
- [[rest-endpoints]] · [[schema-postgres]] · [[module-map]] · [[nestjs-structure]] · [[driver-screens]] · [[web-state-management]] · [[journey-client-book-normal]]
- [[story-rcab-e4-s6-ride-state-machine]] · [[story-rcab-e4-s8-cancellation-paths]] · [[epic-e7-rating-dashboards]]
