# Stakeholder guide: Maintainer (day-to-day operations)

For the person who keeps the service running day to day and handles user issues, without writing code. Screens and checks are shown in the [ops videos](../videos/ops/INDEX.md) (M01 to M06). Deeper on-call material: [monitoring guide](stakeholder-monitoring.md). Technical escalation: [Senior Architect guide](senior-architect.md).

## 1. Daily checks (10 minutes)

1. **Is the service up?** Open the Uptime Kuma page (port 3003 on the dev stack; the "API Health" monitor checks `/v1/health/ready` every minute). Green is healthy (M04).
2. **Grafana overview and dispatch dashboards** (port 3001, M01): drivers online, rides by outcome, nothing red.
3. **Backups**: confirm last night's backup ran. On the server, `/opt/rcab/backups` should contain a new `rcab-<date>.manifest.json` (the manifest is written last, so its presence means the backup is complete) and the file `.last_success` should be recent. Backups run at 21:00 UTC (02:30 IST).
4. **Failed outbox rows**: the Grafana dispatch dashboard panel "outbox exhausted" should be 0. A non-zero value means a booking step could not be published; escalate.
5. **Weekly**: ask the developer on duty for the monthly restore drill result (`docs/operations/recovery-runbook.md`, drills section).

## 2. How to tell the system is healthy

| Signal | Healthy | Where |
|---|---|---|
| Health check | Ready returns OK (database, Redis and routing engine reachable) | Kuma, or open `/v1/health/ready` |
| Active drivers | Roughly the number you expect on shift | Grafana dispatch (M01) |
| Dispatch outcomes | Mostly "assigned", few "no_driver" | Grafana dispatch |
| Error rate | Under 1% of requests are server errors | Grafana overview |
| Outbox backlog | 0 or briefly small; oldest pending age under a minute | Grafana dispatch |

Smoke checks for developers: `pnpm dev:smoke` (dev) and `scripts/prod-smoke.sh` (prod stack), shown in M06.

## 3. Common user issues and what to do

| Report | Meaning | Resolution |
|---|---|---|
| "I cannot sign in" | Sign-in is Google-only until launch: Google account not email-verified, more than 10 attempts in a minute, or the account is suspended | Ask them to wait a minute and retry with a verified Google account; otherwise escalate. |
| Driver: "Not registered as a driver yet" | A first Google sign-in creates a client; an operator must enable the driver account | Run the provisioning script (section 3a), then ask the driver to tap Retry. |
| Passenger: "No driver available" | No driver accepted in about a minute | Check active drivers on Grafana. If zero, ask drivers to go online. Passenger can rebook or schedule. |
| Driver: "I get no offers" | Offline, no active vehicle, vehicle too small, or already on a ride | Run through the driver guide's troubleshooting table. |
| Driver shows offline though app is open | No location update for 60 s (battery optimisation or no signal) | Re-toggle online; OEM settings from the onboarding sheet. |
| Passenger stuck on "Finding your driver" for a scheduled ride | Normal until the search window; the app says "we'll keep trying until..." | No action; it ends as no driver 30 min after pickup time. |
| Ride stuck in a state after outage | Timers are rebuilt after Redis or API restarts | Wait one reconcile cycle (about 5 minutes). Do not delete rows or cancel by hand. |
| Double booking complaint | Retried requests are de-duplicated | Check ride list; if two exist, escalate with both ids. |
| Shared-ride fare dispute | Fare is fixed at join by design (Phase-0) | Explain the rule; escalate policy questions to the owner (E8.S9). |
| Rating not showing | Ratings are stored, display is a future feature (E7) | Explain. |

When investigating, ask for the time and the ride id; developers can follow one request end to end by request id in Loki logs (M03).

### 3a. Enabling a driver account

After the driver has signed in once with Google, ask the developer on duty to run, against the right database:

```bash
scripts/provision-driver.sh <driver-email> [--vehicle-reg <reg>] [--dry-run] [--database-url <url>]
```

Run with `--dry-run` first: it prints the account it found and what it would change. It refuses when no account, several accounts or a suspended account match, so a refusal is a prompt to check the email, not an error to work around. It is safe to re-run. The driver taps **Retry** on the app's "Not registered as a driver yet" screen (or waits up to 15 minutes); no reinstall or fresh sign-in is needed.

## 4. Configuration knobs and who may change them

All business rules live in one table: `docs/POLICY.md` (generated from `apps/api/src/config/policy/policy.schema.ts`). The API validates them at startup and refuses to start if a value is invalid, so a typo cannot silently change pricing.

Examples a maintainer will be asked about:

| Rule | Current default | Env var |
|---|---|---|
| Fare: base / per km / per minute | 40 / 15 / 2 rupees | `FARE_BASE_CENTS`, `FARE_PER_KM_CENTS`, `FARE_PER_MIN_CENTS` (in paise) |
| Offer time to respond | 12 s | `DISPATCH_OFFER_TTL_MS` |
| Search rounds | 5 drivers / 2 km, then 10 drivers / 4 km; fail at 60 s | `DISPATCH_K1/K2/R1/R2`, `DISPATCH_HARD_FAIL_MS` |
| Scheduled window | 15 min to 24 h ahead; search starts 10 min before | `SCHEDULED_MIN_LEAD_MS`, `SCHEDULED_MAX_LEAD_MS`, `SCHEDULED_WAKE_LEAD_MS` |
| Shared pool | open 60 s, 3 seats | `MATCHING_POOL_TIMEOUT_MS`, `MATCHING_MAX_SEATS` |
| Driver no-show wait | 5 min | `RIDE_NO_SHOW_WAIT_MS` |
| Driver idle timeout | 60 s | `DRIVER_STALE_AFTER_MS` |
| Platform commission | 20% | `PLATFORM_COMMISSION_RATE` |

Who may change what:

- **Maintainers do not edit config or code.** Change requests go to the product owner, who approves; a developer sets the env var for one deployment, or edits the default in the policy schema (all environments), then regenerates the doc with `pnpm policy:doc`.
- Pricing, shared-fare and cancellation rules are **owner decisions** (see the manager guide).
- Secrets (JWT secret, Firebase credentials, backup keys, database passwords) are owner-managed. Never share them in chat or tickets; changes follow `80-infrastructure/secrets-management.md`.
- Some rules (who can cancel from which state) are fixed in code and need a developer and a story.

## 5. Backups and restores (what you must know)

- Nightly encrypted backup; kept 30 days plus 12 monthly. Without the owner's offsite setup, backups live on the same server disk, so a lost disk loses them.
- Up to about 24 hours of data can be lost in a restore. A restore logs every user out and requires drivers to go online again.
- Restores are performed by DevOps following `docs/operations/recovery-runbook.md`, never by editing the database by hand.

## 6. Escalation

| Situation | Escalate to |
|---|---|
| Service down more than 5 minutes, health check red | DevOps / on-call developer (see monitoring guide) |
| Backup missing or failed, outbox exhausted > 0, data looks wrong | On-call developer immediately |
| Fare, cancellation or policy question | Product owner / manager |
| Security concern or suspected leaked secret | Owner and Senior Architect, immediately |
| User-visible bug | Create an issue with time, ride id, screenshots; link the video scene that shows expected behaviour (web W-series, driver D-series) |

No on-call rota or named contacts are stored in the repo: the manager must publish one before the pilot.
