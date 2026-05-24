---
title: Reading paths — task to minimum note set
tags: [moc, llm, navigation]
status: living
audience: llm
---

# Reading paths

Each entry below maps a class of task to the **minimum set of notes** an LLM (or human) must load to do the task correctly. Load the notes in order. Follow `depends_on:` frontmatter transitively to depth 2.

If your task does not match any path here, add a new one before starting work. 

---

## Backend implementation

### `path:implement-otp-signup`
Implement Firebase Phone Auth → JWT exchange → user create.
- [[journey-client-otp-signup]]
- [[integration-firebase-phone-auth]]
- [[module-auth]]
- [[entity-user]] · [[entity-client]]
- [[schema-postgres]] (auth/user tables)
- [[api-conventions]] · [[error-codes]]
- [[ADR-0003-otp-firebase]]

### `path:implement-google-account-link`
Link a verified-phone user to a Google account for subsequent logins.
- [[journey-client-google-link]]
- [[integration-google-account-link]]
- [[module-auth]]
- [[entity-user]]

### `path:implement-normal-booking`
Single-rider point-to-point booking, top-k dispatch to drivers.
- [[features-normal-booking]] · [[journey-client-book-normal]]
- [[entity-ride]] · [[entity-ride-request]] · [[entity-route]] · [[entity-location]]
- [[sm-ride-lifecycle]] · [[sm-booking-flow]]
- [[module-rides]] · [[module-dispatch]] · [[module-realtime]]
- [[algo-top-k-dispatch]]
- [[rest-endpoints]] · [[websocket-events]]
- [[redis-usage]] (driver geo index, dispatch state)

### `path:implement-shared-booking`
Pool a client into an existing shared ride or open a new one.
- [[features-shared-rides]] · [[journey-client-book-shared]]
- [[entity-shared-ride]] · [[entity-route]] · [[entity-ride]]
- [[sm-shared-ride-pool]]
- [[algo-shared-ride-matching]] · [[algo-route-similarity]]
- [[module-matching]] · [[module-rides]]

### `path:implement-scheduled-booking`
Booking placed now for a future time window.
- [[features-scheduled-booking]] · [[journey-client-book-scheduled]]
- [[entity-ride-request]] · [[sm-booking-flow]]
- [[module-rides]] · [[module-dispatch]]
- (job runner notes in [[redis-usage]] + [[docker-compose]])

### `path:implement-driver-online-flow`
Driver toggles online; appears in dispatch index.
- [[journey-driver-go-online]]
- [[entity-driver]] · [[sm-driver-availability]]
- [[module-realtime]] · [[redis-usage]]
- [[driver-background-location]]

### `path:implement-rating`
Driver rates client, client rates driver, aggregate fairly with cold-start.
- [[features-rating-system]] · [[entity-rating]]
- [[algo-rating-aggregation]]
- [[module-rides]]

### `path:implement-history-dashboard`
Past rides + metrics for clients and drivers.
- [[features-history-dashboard]]
- [[entity-ride]] · [[entity-rating]]
- [[rest-endpoints]]

## Frontend implementation

### `path:implement-web-client-shell`
Next.js app skeleton: routing, auth context, layout, PWA.
- [[web-nextjs-structure]] · [[web-pages-routes]] · [[web-state-management]]
- [[web-pwa-strategy]] · [[web-auth-firebase]]
- [[integration-firebase-phone-auth]]

### `path:implement-web-booking-map`
The OSM-powered pick/drop selector and route preview.
- [[web-osm-integration]]
- [[integration-openstreetmap]] · [[integration-nominatim]] · [[integration-osrm]]
- [[features-normal-booking]] · [[features-shared-rides]]

### `path:implement-driver-app-shell`
Flutter app skeleton: navigation, state mgmt, auth, FCM, background location.
- [[driver-flutter-structure]] · [[driver-screens]] · [[driver-state-management]]
- [[driver-background-location]] · [[driver-push-notifications]]
- [[integration-fcm]]

### `path:implement-driver-navigation-handoff`
Open Google Maps with turn-by-turn for the active ride.
- [[driver-google-maps-handoff]]
- [[integration-google-maps-deeplink]]

## Infrastructure

### `path:provision-vps`
Set up the Phase-0 single VPS.
- [[vps-topology]] · [[docker-compose]]
- [[nginx-reverse-proxy]] · [[ssl-letsencrypt]]
- [[secrets-management]] · [[backups]]
- [[ADR-0009-single-vps-phase-0]]

### `path:set-up-observability`
Logs, metrics, alerting on the VPS.
- [[observability]] · [[vps-topology]]
- [[performance-budget]]

### `path:set-up-ci-cd`
Build, test, deploy pipeline.
- [[ci-cd]] · [[testing-strategy]]
- [[docker-compose]]

## Cross-cutting

### `path:add-new-entity`
Add a new domain entity to the vault and code.
- [[data-model]] · [[conventions]]
- One existing entity for template (e.g. [[entity-ride]])
- [[schema-postgres]] · [[migrations]]

### `path:make-architectural-decision`
You are about to commit to a non-trivial design choice.
- [[conventions]] (ADR section)
- [[adr-template]]
- Read every existing ADR in `99-decisions/` to avoid contradiction

### `path:onboard-fresh-llm`
A new session needs to understand the project from zero.
- [[HOME]] · [[LLM-INSTRUCTIONS]] · [[reading-paths]] (this file)
- [[vision]] · [[phase-0]]
- [[system-overview]] · [[tech-stack]]
- [[module-map]]

## Delivery (how-to-ship)

### `path:start-implementation`
You are Claude Code, just opened. You want to begin implementing the project.
- [[claude-code-launch-prompt]] (load it; it already names everything else)
- [[delivery-roadmap]] · [[demo-cadence]]
- [[hitl-touchpoints]] · [[impact-analysis]]
- [[commit-story-linkage]] · [[stories-index]]
- [[local-system-probe]]

### `path:work-a-story`
You picked up a `ready` story. You want to implement it.
- The story file (frontmatter has `epic:`, `affected_notes:`, `depends_on:`)
- Every note listed in the story's `affected_notes` and `depends_on`
- [[story-template]] · [[commit-story-linkage]] · [[demo-cadence]]
- [[testing-strategy]] for the test plan layer
- [[docker-dev-environment]] · [[docker-test-environment]] for the run/test loop

### `path:add-new-story`
A new story needs to exist (mid-flight discovery, retro follow-up, dev request).
- [[stories-index]] · [[story-template]] · [[story-id-scheme]]
- [[impact-analysis]] (if it touches existing scope)
- [[commit-story-linkage]]

### `path:run-impact-analysis`
A scope change is proposed; you must analyze before acting.
- [[impact-analysis]] (the 6-question process)
- [[delivery-roadmap]] · [[stories-index]]
- [[hitl-touchpoints]]

### `path:bootstrap-demo-0`
First demo, "Hello, stack." Everything from empty repo to docker compose up + ready endpoint green.
- [[epic-e1-foundation]] + its 9 stories ([[story-rcab-e1-s1-repo-scaffold]] … [[story-rcab-e1-s9-system-probe]])
- [[docker-dev-environment]] · [[docker-test-environment]] · [[docker-compose]]
- [[ci-cd]] · [[observability]] · [[vps-topology]]
- [[ADR-0007-monorepo-layout]] · [[ADR-0009-single-vps-phase-0]]

### `path:walk-a-demo`
A demo is ready to sign off.
- The owning epic's note
- [[demo-cadence]] (the per-demo contract)
- [[performance-budget]] · [[observability]]
- [[hitl-touchpoints]] (sign-off discipline)

---

## See also
- [[HOME]] · [[LLM-INSTRUCTIONS]] · [[conventions]]
