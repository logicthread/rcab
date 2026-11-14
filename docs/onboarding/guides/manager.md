# Guide: Manager

Audience: engineering or delivery manager taking over rcab. Plain-language, no code needed. Companions: [Senior Architect guide](senior-architect.md) for risks in depth, [README](../README.md) for the whole pack, demo videos in [web](../videos/web/INDEX.md), [driver app](../videos/driver/INDEX.md) and [ops](../videos/ops/INDEX.md).

## 1. What the product does today

rcab is a ride-hailing platform for one city pilot: passengers book on a web app, drivers use an Android app, an API matches them, and an operations stack watches it all. Everything runs on one server (Phase-0, ADR-0009).

Working end to end: phone sign-in, driver go-online, normal rides (quote, book, offers to nearby drivers, ride steps, cancellation, rating), shared rides (several passengers pooled into one trip with stops), scheduled rides (book 15 min to 24 h ahead, the system starts looking 10 minutes before pickup and keeps trying up to 30 minutes after pickup time), live tracking, dashboards, backups and a release pipeline.

Not yet there: driver earnings and history screens, rating averages and moderation (E7), working alerts to a chat channel, security/TLS audit, pilot runbooks (E8/E9). Payments are not in the product: fares are shown, collection is outside the system.

## 2. Status per epic

Source of truth: `95-delivery/stories-index.md` (symbols: done, in progress, ready, draft, blocked). Snapshot at time of writing; re-read the file.

| Epic | Demo headline | State |
|---|---|---|
| E1 Foundation | Demo 0 "Hello, stack" | All 15 stories done. |
| E2 Auth and identity | Demo 1 "I am a real user" | Done. |
| E3 Driver presence | Demo 2 "The driver is online" | Done. |
| E4 Normal booking | Demo 3 "Book a normal ride" | Done. |
| E5 Shared booking | Demo 4 "Shared works" | Done; sign-off recorded in git history. |
| E6 Scheduled booking | Demo 5 "Scheduled works" | All stories done; the Demo 5 sign-off walk by the owner is still owed. |
| E7 Rating and dashboards | Demo 6 | Not started (4 draft stories: rating moderation, aggregation, history page, earnings). |
| E8 Production hardening | Demo 7 "Production-grade" | In flight. Done work: remediation stages A to E, central policy config, release pipeline, business metrics and load scenarios, scheduled cutoff and searching UI, backups and restore drill (mostly merged). Open: dashboards, alert delivery, security sweep, load proof on target hardware, TLS audit, shared fare policy, this onboarding pack (S14). The index still shows several E8 rows as in progress; reconcile before reporting. |
| E9 Pilot rollout | Demo 8 "Real drivers, real city" | Not started (4 draft stories). |

## 3. Delivery model

- **Stories** are the unit of work (`RCAB-Ex.Sy`). Lifecycle: draft, ready, in progress, done. One story at a time per epic. Template: `95-delivery/story-template.md`.
- **Commits** follow a convention and must name their story in a `Story:` trailer; a hook enforces it. See `95-delivery/commit-story-linkage.md`.
- **Demos** close an epic. Demo-done means all stories done, the flow runs from a fresh `docker compose up`, CI is green, Grafana panels show data, performance is within budget, and the owner has personally walked it and signed off (a `Sign-off:` trailer on the merging commit). Rules: `95-delivery/demo-cadence.md`.
- **HITL (human in the loop) stops** are decisions the AI assistant must not make alone: new or changed ADRs, deploying to a real server, touching secrets handling, adding a paid or lock-in service, changing a demo headline or reordering epics, changing acceptance criteria mid-story, quarantining a flaky test, demo sign-off. Full list: `95-delivery/hitl-touchpoints.md`. Mid-flight scope changes go through `95-delivery/impact-analysis.md`.
- **Gate**: `pnpm verify` (lint, API coverage floor, integration tests on real containers) must pass before a story is closed. Skipping the container tests never counts as green.
- Day-to-day skills (`/pickup-story`, `/close-story`, `/ship-story`, and others) are listed in `CLAUDE.md`.

## 4. Team roles mapped to guides

| Role | Start here |
|---|---|
| UI/UX developer | UI/UX developer guide in this folder |
| Backend developer | Backend developer guide |
| DevOps | DevOps guide |
| Monitoring and maintenance developer | Monitoring and maintenance developer guide |
| Senior architect | [senior-architect.md](senior-architect.md) |
| Manager (you) | this page |
| Passenger-side stakeholder | [stakeholder-user-app.md](stakeholder-user-app.md) |
| Driver-side stakeholder | [stakeholder-driver-app.md](stakeholder-driver-app.md) |
| Operations / content maintainer | [stakeholder-maintainer.md](stakeholder-maintainer.md) |
| On-call / monitoring staff | [stakeholder-monitoring.md](stakeholder-monitoring.md) |

The developer guides are written by sibling authors; see [README](../README.md) for exact file names.

## 5. Roadmap

1. **E7 Rating and dashboards (Demo 6)**: weighted rating aggregation, moderation view, "New" badge for unrated drivers, passenger ride history, driver earnings (today/week/month). Visible user value; the earnings screen in the driver app is currently a placeholder.
2. **E8 Production hardening (Demo 7)**: finish dashboards, alert delivery, security checklist, TLS/HSTS/CSP, load proof on the real VPS class, decide shared fare policy, first real deploy.
3. **E9 Pilot rollout (Demo 8)**: driver verification runbook, launch checklist with go/no-go, weekly review and bug triage, scale-out checklist.

Phase-1 (multi-host, iOS and so on) is deliberately out of scope; triggers are in `20-architecture/scaling-strategy.md`.

## 6. Decisions waiting on the owner

| Decision | Why it blocks | Where |
|---|---|---|
| Shared-ride fare policy (E8.S9) | Today fares are fixed when a passenger joins; no refunds or adjustments. Needs rules plus a settlement record. | `95-delivery/stories/story-rcab-e8-s9-shared-fare-readjustment-policy.md` |
| Offsite backup destination | Without it, losing the server disk loses all backups; data-loss window is up to 24 h. | `docs/operations/recovery-runbook.md` |
| Deploy credentials, first real VPS deploy | HITL stop; registry login and env secrets are owner-managed. | `scripts/deploy/README.md` |
| Alert channel (Slack webhook or other) | Alerts exist for 5xx and latency but go nowhere. | `80-infrastructure/observability.md` |
| Pool edge cases (member cancel, fallback to solo, early assignment for scheduled) | Behaviour undefined in product terms. | `docs/remediation/stage-c-contract.md` section 9 |
| Demo 5 sign-off walk | Epic E6 cannot be declared complete. | `docs/manual-testing/demo-walkthrough.md` |
| Cancellation fees | Phase-0 has none; confirm for pilot. | `docs/POLICY.md` |

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation / owner |
|---|---|---|---|
| Data loss from a single server and no offsite backup | Medium | High | Configure offsite, run monthly restore drill (devops, owner decision). |
| Incidents unnoticed (alerts not delivered) | High today | High | Wire Alertmanager and Kuma to a channel (E8.S2). |
| Business rules changed by accident | Low | Medium | All rules live in one validated config (`docs/POLICY.md`), generated doc fails CI on drift. |
| Fare disputes in shared rides | Medium | Medium | Decide E8.S9 before pilot. |
| Performance unknown on real hardware | Medium | Medium | E8.S5 load run on target VPS class; budget in `90-quality/performance-budget.md`. |
| Drivers appear offline due to phone battery optimisation | Medium | Medium | In-app OEM guidance exists (E3.S6); cover in driver onboarding. |
| Drivers without a registered vehicle receive no offers | Medium | Medium | Pilot onboarding must register vehicles (E9.S1). |
| Progress reporting drift (index vs reality) | Medium | Low | Reconcile `stories-index.md` before each status report. |
| Single-VPS capacity | Low for pilot | High later | Scaling signals tracked via dashboards (see monitoring guide). |

## 8. How to read progress

1. `95-delivery/stories-index.md`: first in-progress row is current work; counts of done per epic are your burn-up.
2. `git log` shows `Story:` trailers per commit, so any commit maps back to a story.
3. Story files under `95-delivery/stories/` hold acceptance criteria and test plans.
4. Grafana overview and dispatch dashboards show real usage (see monitoring guide).
5. Demo recordings in this pack show what the product actually does today.

## 9. Definition of done

- **Story**: every acceptance criterion has a passing test, affected vault notes updated, commits carry the `Story:` trailer, build and tests green from clean checkout, no dangling vault links, `pnpm verify` passes.
- **Demo**: all stories done, runs from a fresh `docker compose up`, CI green, dashboards show data and budget met, owner has walked it and signed off.
- **Onboarding pack (E8.S14)**: owner reviews the pack and the recordings deck before it goes to the new team.
