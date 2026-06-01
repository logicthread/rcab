---
title: Stories — index & hierarchy
tags: [layer/delivery, kind/moc]
status: living
phase: 0
depends_on: [[delivery-roadmap]]
related: [[story-template]], [[story-id-scheme]], [[commit-story-linkage]]
audience: both
---

# Stories — index & hierarchy

*The full backlog. Each row is a story; each header is an epic. New stories are appended (never re-numbered). Picked up in roughly demo order; deviations are fine if a story is blocked.*

## Legend

`■ done`  `▶ in_progress`  `□ ready`  `· draft`  `× blocked`  `– dropped`

---

## E1 — Foundation → Demo 0 · "Hello, stack"
*Repo, dockerized environments, CI/CD, observability scaffolding.* See [[epic-e1-foundation]].

| ID | Title | Status |
|---|---|---|
| RCAB-E1.S0 | Vault scaffold (this work) | ■ |
| RCAB-E1.S1 | [[story-rcab-e1-s1-repo-scaffold]] — monorepo skeleton (pnpm + turborepo + apps/ + packages/) | ■ |
| RCAB-E1.S2 | [[story-rcab-e1-s2-docker-dev]] — `docker-compose.dev.yml` + devcontainer | ■ |
| RCAB-E1.S3 | [[story-rcab-e1-s3-docker-test]] — `docker-compose.test.yml` + testcontainers harness | ■ |
| RCAB-E1.S4 | [[story-rcab-e1-s4-docker-prod]] — `docker-compose.prod.yml` + nginx + Let's Encrypt | ■ |
| RCAB-E1.S5 | [[story-rcab-e1-s5-ci-cd]] — GitHub Actions: lint / unit / integration / build / deploy | ■ |
| RCAB-E1.S6 | [[story-rcab-e1-s6-observability]] — Loki + Prometheus + Grafana + Uptime Kuma | ■ |
| RCAB-E1.S7 | [[story-rcab-e1-s7-db-bootstrap]] — Postgres + Redis + OSRM containers, migration runner | ■ |
| RCAB-E1.S8 | [[story-rcab-e1-s8-health-endpoints]] — `/v1/health/live`, `/v1/health/ready` | ■ |
| RCAB-E1.S9 | [[story-rcab-e1-s9-system-probe]] — `pnpm system:probe` (host capability + load estimate) | ■ |

## E2 — Auth & Identity → Demo 1 · "I am a real user"
*Firebase phone OTP, JWT issue/refresh, Google linking.* See [[epic-e2-auth]].

| ID | Title | Status |
|---|---|---|
| RCAB-E2.S1 | [[story-rcab-e2-s1-otp-exchange]] — OTP exchange endpoint + Firebase Admin verifier | ■ |
| RCAB-E2.S2 | [[story-rcab-e2-s2-jwt-refresh]] — rcab JWT issue/refresh + revocation | ■ |
| RCAB-E2.S3 | [[story-rcab-e2-s3-web-otp-flow]] — Web OTP flow (reCAPTCHA + signInWithPhoneNumber) | ■ |
| RCAB-E2.S4 | [[story-rcab-e2-s4-google-link]] — Google link/login endpoints + ID-token verify | ■ |
| RCAB-E2.S5 | [[story-rcab-e2-s5-cookie-csrf]] — Refresh-token cookie + CSRF posture | ■ |
| RCAB-E2.S6 | [[story-rcab-e2-s6-auth-integration-tests]] — Auth integration tests + negative cases | ■ |

## E3 — Driver presence → Demo 2 · "The driver is online"
*Driver app shell, go online, Redis geo index, location stream.* See [[epic-e3-driver-presence]].

| ID | Title | Status |
|---|---|---|
| RCAB-E3.S1 | [[story-rcab-e3-s1-flutter-app-skeleton]] — Flutter app skeleton: routing, theme, Riverpod, dio + refresh | ■ |
| RCAB-E3.S2 | [[story-rcab-e3-s2-firebase-otp-flutter]] — Firebase OTP in Flutter | ■ |
| RCAB-E3.S3 | [[story-rcab-e3-s3-vehicle-registration]] — Vehicle registration screen + API | ■ |
| RCAB-E3.S4 | [[story-rcab-e3-s4-driver-online-toggle]] — Online / offline toggle + foreground service | ■ |
| RCAB-E3.S5 | [[story-rcab-e3-s5-location-streaming]] — Location streaming (WS) + Redis `GEOADD` | ■ |
| RCAB-E3.S6 | [[story-rcab-e3-s6-oem-kill-mitigation]] — OEM-kill mitigation onboarding | ■ |

## E4 — Normal booking → Demo 3 · "Book a normal ride"
*OSM picker, quote, request, top-K dispatch, ride lifecycle, rating prompt.* See [[epic-e4-normal-booking]].

| ID | Title | Status |
|---|---|---|
| RCAB-E4.S1 | [[story-rcab-e4-s1-web-booking-screen]] — Web booking screen (Leaflet pick/drop, Nominatim, OSRM quote) | ■ |
| RCAB-E4.S2 | [[story-rcab-e4-s2-quote-request-endpoints]] — Quote + request endpoints with idempotency | ■ |
| RCAB-E4.S3 | [[story-rcab-e4-s3-dispatch-geo-candidates]] — Dispatch — geo candidate selection + offer fan-out | ■ |
| RCAB-E4.S4 | [[story-rcab-e4-s4-solo-dispatch-claim]] — Dispatch — claim, revoke, wave-2, hard-fail | ■ |
| RCAB-E4.S5 | [[story-rcab-e4-s5-driver-offer-screen]] — Driver offer screen + accept/decline | ■ |
| RCAB-E4.S6 | [[story-rcab-e4-s6-ride-state-machine]] — Ride state machine (solo: accepted → en_route → arrived → in_progress → completed) | ■ |
| RCAB-E4.S7 | [[story-rcab-e4-s7-driver-location-stream]] — Driver location stream → client WS (1 Hz throttle) | ■ |
| RCAB-E4.S8 | [[story-rcab-e4-s8-cancellation-paths]] — Ride cancellation & no-show paths | ■ |
| RCAB-E4.S9 | [[story-rcab-e4-s9-rating-prompts]] — Rating prompts post-completion | ■ |

## E5 — Shared booking → Demo 4 · "Shared works"
*Pool, route similarity, matching, shared lifecycle.* See [[epic-e5-shared-booking]].

| ID | Title | Status |
|---|---|---|
| RCAB-E5.S1 | [[story-rcab-e5-s1-route-similarity-scorer]] — Route similarity scorer + cached OSRM polylines | ■ |
| RCAB-E5.S2 | [[story-rcab-e5-s2-matching-service-slot-vs-open]] — Matching service: slot vs. open decision | ■ |
| RCAB-E5.S3 | [[story-rcab-e5-s3-pool-lifecycle]] — Pool lifecycle (open → grow → close → start) | ■ |
| RCAB-E5.S4 | [[story-rcab-e5-s4-shared-ride-dispatch]] — Shared-ride dispatch (offer reflects pool span) | ■ |
| RCAB-E5.S5 | [[story-rcab-e5-s5-shared-ride-pricing]] — Shared-ride pricing per seat | ■ |
| RCAB-E5.S6 | [[story-rcab-e5-s6-web-booking-share-ui]] — Web booking UI — 'Share' default + pool-update events | ■ |
| RCAB-E5.S7 | [[story-rcab-e5-s7-driver-app-multi-stop]] — Driver app — multi-stop ride screen, per-passenger drop | ■ |

## E6 — Scheduled booking → Demo 5 · "Scheduled works"
*BullMQ delayed jobs, wake-up dispatch.* See [[epic-e6-scheduled-booking]].

| ID | Title | Status |
|---|---|---|
| RCAB-E6.S1 | BullMQ runner + Redis configuration | · |
| RCAB-E6.S2 | `type=scheduled` flow at quote + request | · |
| RCAB-E6.S3 | Wake-up worker → reuse normal dispatch path | · |
| RCAB-E6.S4 | Cancellation before/after wake | · |

## E7 — Rating & dashboards → Demo 6 · "Dashboards & ratings"
*Two-sided rating store + aggregation; history + earnings dashboards.* See [[epic-e7-rating-dashboards]].

| ID | Title | Status |
|---|---|---|
| RCAB-E7.S1 | Rating moderation view + cold-start "New" display (insert + invariants shipped in RCAB-E4.S9) | · |
| RCAB-E7.S2 | Weighted-recency aggregation job + denorm fields | · |
| RCAB-E7.S3 | Web history page (list, detail) | · |
| RCAB-E7.S4 | Driver earnings dashboard (today / week / month) | · |

## E8 — Production hardening → Demo 7 · "Production-grade"
*Alerts, backups, security, load.* See [[epic-e8-production-hardening]].

| ID | Title | Status |
|---|---|---|
| RCAB-E8.S1 | Grafana dashboards filled with real query expressions | · |
| RCAB-E8.S2 | Alertmanager rules wired to Slack | · |
| RCAB-E8.S3 | Backup container + monthly restore drill | · |
| RCAB-E8.S4 | Security checklist sweep — every item green | · |
| RCAB-E8.S5 | k6 load test: confirm Phase-0 perf budget on target VPS class | · |
| RCAB-E8.S6 | TLS + HSTS + CSP audit | · |

## E9 — Pilot rollout → Demo 8 · "Real drivers, real city"
*Closed pilot, observation, iteration to Phase-0 scale.* See [[epic-e9-pilot-rollout]].

| ID | Title | Status |
|---|---|---|
| RCAB-E9.S1 | Pilot onboarding runbook (manual driver verification) | · |
| RCAB-E9.S2 | Pilot launch checklist + go/no-go | · |
| RCAB-E9.S3 | Weekly review template + bug triage | · |
| RCAB-E9.S4 | Scale-out checklist to Phase-0 targets | · |

---

## How to add a new story

1. Decide the epic. If none fits, propose a new epic and run [[impact-analysis]] first.
2. Get the next free `S<m>` for that epic. Append to this index — never reorder existing rows.
3. Create the story file under `95-delivery/stories/` using [[story-template]].
4. Commit: `feat(vault): add RCAB-Ex.Sy — <subject>` with `Story: RCAB-Ex.Sy` trailer.
5. Pickup discipline: a story is pickable only when `status: ready` (review pass complete).

## See also
- [[delivery-roadmap]] · [[story-template]] · [[story-id-scheme]] · [[commit-story-linkage]]
- [[hitl-touchpoints]] · [[impact-analysis]]
