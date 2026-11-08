---
title: RCAB-E8.S13 — Scheduled retry cutoff + passenger searching state
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S13
demo: 7
estimate: m
hitl: no
depends_on: [[story-rcab-e8-s8-review-remediation-stage-c]], [[story-rcab-e8-s10-central-policy-config]]
blocks:
affected_notes: [[features-scheduled-booking]], [[policy-config]]
owner: claude
audience: both
---

# RCAB-E8.S13 — Scheduled retry cutoff + passenger searching state

## Goal

RCAB-E8.S8 made an unanswered scheduled ride retry forever (new dispatch generation, fresh 4-minute window, no cap), so a ride nobody accepted kept being re-armed long after its pickup time had passed. The owner decided (2026-11-08): stop retrying 30 minutes after the scheduled pickup, tunable. After that moment the ride ends as `no_driver` through the same terminal path and passenger notification as a normal ride. The web booking/tracking UI also never said what was going on while the search was re-armed; it now shows "Still looking for a driver — we'll keep trying until <time>" with a Cancel button, using the cutoff the server sends.

## User-facing acceptance criteria

- Given a scheduled ride that no driver accepted, When its accept window closes before `scheduled_for + 30 min`, Then it is re-armed with a fresh window and stays `requested`.
- Given a scheduled ride that no driver accepted, When its accept window closes after `scheduled_for + 30 min`, Then the ride becomes `no_driver` and the passenger receives `ride_no_driver` + `ride_state_changed(no_driver)` exactly like a normal ride.
- Given a scheduled ride whose search was re-armed, When the passenger watches the tracking panel, Then it reads "Still looking for a driver — we'll keep trying until <time>" with a Cancel button; the time is shown only if the server sent `retryUntil`.
- Given the ride ends as `no_driver`, Then the normal "No driver available — please try again" message replaces the searching banner.
- Given the passenger reloads or reconnects mid-search, Then `ride:snapshot` restores the searching state (including the cutoff).

## Technical acceptance criteria

- New policy knob `scheduled.retryCutoffAfterPickupMs` (env `SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS`, default 1 800 000 ms, min 0) in `policy.schema.ts`; `pnpm policy:doc` regenerated `docs/POLICY.md` + `api.env.example`; `pnpm policy:doc:check` passes. No client-side constant: the web app reads the cutoff from the server.
- `rearmScheduledRide(db, rideId, generation, { cutoffAfterPickupMs })` decides inside the ride-row lock transaction: past the cutoff it sets `no_driver` and revokes live offers (no generation bump, no outbox intent); otherwise it re-arms as before. Cancel / accept / cutoff stay mutually exclusive through the same row lock; a duplicate timer is a no-op.
- Both the hard-fail path (`DispatchService.handleHardFail`, scheduled branch) and the reconciler (`DispatchReconciler`, scheduled branch) use it; both send the passenger `ride_no_driver` and `ride_state_changed(no_driver)`, revoke offers and drop timers. The reconciler reports `scheduledExpired`.
- `ride_dispatch_retry` payload gains `retryUntil` (ISO); `ride:snapshot` gains `retryUntil` (ISO or null), non-null only for a woken scheduled ride that is still `requested`/`dispatching` without a driver.
- Metric: `rcab_dispatch_outcome_total{outcome="scheduled_no_driver"}`.

## Test plan

- Unit: policy default/override/bounds; `scheduledRetryUntil`; `handleHardFail` passes the cutoff and, on a `no_driver` outcome, emits the normal terminal events; reconciler counts/notifies and survives a notification failure; snapshot `retryUntil` matrix; web store, ws wrapper, tracking panel and book-client RTL.
- Integration (`scheduled-retry.int.spec.ts`): re-arm before the cutoff (even after pickup), `no_driver` after the cutoff (offers revoked, no intent, duplicate is a no-op), tunable cutoff, race with an accept holding the row lock, race with cancel, reconciler ends a ride past the cutoff.

## Out of scope

- A web time selector for creating scheduled rides (the API supports them; the booking form does not yet).
- Driver-app changes.
- Notifying the passenger on every re-arm (still first re-arm only, E8.S8).

## Notes / questions

- The cutoff is evaluated when a window closes, so a ride can run for up to one extra window (4 min by default) past `retryUntil` before it ends.

## See also

- [[epic-e8-production-hardening]] · [[story-rcab-e8-s8-review-remediation-stage-c]] · [[story-rcab-e8-s10-central-policy-config]]
- [[features-scheduled-booking]] · [[policy-config]]
