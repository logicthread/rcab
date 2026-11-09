# Workflow: incident and recovery

The operational source of truth is **[`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md)**.
Read it once, calmly, before you are on call. This page is the triage layer on top: *what to look at first, which
runbook section applies, and what is explicitly not proven*. Honest status from the runbook: **nothing has been run
against a production VPS**; the drills ran on fixtures and throwaway databases; RPO is up to ~24 h; RTO on
production-sized data is unmeasured.

Prerequisite reading: [state-machines.md](../state-machines.md) (what "correct" looks like for each lifecycle),
[debugging-and-tooling.md](debugging-and-tooling.md) (queries and dashboards), [release-and-deploy.md](release-and-deploy.md)
(rollback). Ops videos: [M01–M06](../videos/ops/INDEX.md), including the restore-drill terminal recording
([M06](../videos/ops/INDEX.md#m06)).

## 1. Know what is authoritative

| Data | Authority | If lost |
|---|---|---|
| Rides, pools, members, offers, driver assignment guard, outbox, sessions, idempotency | **Postgres** | Restore from backup (runbook section 4). Everything since the last backup is gone |
| BullMQ queues, `pool:<id>` hashes, `driver:state:<id>.current_ride_id`, geo index, presence | **Redis — a rebuildable projection** | Availability only. Restart the api; it rebuilds from Postgres (runbook section 5, proved by `redis-loss-drill.sh`) |
| OSRM graph | rebuilt from the OSM extract | re-run `osrm-prep` / `osrm-extract` (minutes) |
| Secrets, the backup **age identity** | the owner, **off the VPS** | not recoverable by this runbook (`80-infrastructure/secrets-management.md`, HITL) |

## 2. First ten minutes (any incident)

1. **Scope it.** Which surface (rider web, driver app, both)? Since when? Did a deploy happen? (`/v1/health/version`;
   the Jenkins history; `RCAB_PREVIOUS_VERSION` on the host.)
2. **Health.** `curl https://<api>/v1/health/ready` (postgres, redis, osrm each reported). Uptime Kuma, then Grafana
   overview: request rate, error ratio, p95/p99 (alerts `ApiHighErrorRate`, `ApiHighP99Latency` fire from
   `infra/observability/alert_rules.yml` to Alertmanager).
3. **Business health.** Dispatch dashboard: `rcab_dispatch_outcome_total` (rising `no_driver` with healthy drivers?),
   `rcab_active_drivers` (zero means no presence heartbeats arriving), `rcab_outbox_pending` /
   `rcab_outbox_oldest_pending_age_seconds` / `rcab_outbox_exhausted`.
4. **Find a failing request.** Take the `x-request-id` from the client/response and search Loki:
   `{container="…api…"} | json | request_id = "<id>"`.
5. **Decide: roll back or fix forward.** A bad release with a schema both versions accept: roll back
   ([release-and-deploy.md](release-and-deploy.md) section 6). A data problem: do **not** roll back images; go to the
   table below.
6. **Communicate and write it down.** Use `/engineering:incident-response` for the status updates and blameless
   write-up; record the timeline (detect, decide, act, recover) — that is how RTO becomes a measured number.

## 3. Symptom to action

| Symptom | Probable cause | Do this |
|---|---|---|
| All requests 5xx right after a deploy | bad release or bad config (policy validation fails closed at boot with a list of bad keys) | check the api log for `Invalid business policy configuration`; roll back (automatic if verification failed) |
| `ready` shows redis down / flushed | Redis crash or flush | restart redis then the api; it rebuilds projections and timers from Postgres (runbook section 5). Drivers re-announce presence; rides in flight continue |
| Rides stay `requested`, no offers | outbox not draining, BullMQ lost its jobs, no eligible drivers, OSRM down | `rcab_outbox_pending` and `outbox` rows (`last_error`); `/osrm-check`; the reconciler re-arms missing work at boot and every 5 min — restart the api to trigger it immediately; see below for `exhausted` |
| `rcab_outbox_exhausted > 0` | an intent failed `max_attempts` (10) times or had a permanent error (unknown topic) | read `outbox.last_error`; fix the cause; the reconciler `rearm()`s eligible rows, or re-arm one by hand (below) |
| Driver says "online" but gets nothing | presence swept (silent > 60 s), vehicle missing, existing assignment/offer | `driver:state:<id>`; `driver_active_assignment`; `eligibleCandidates` rules in [state-machines.md](../state-machines.md#6-driver-presence) |
| Driver stuck "on a ride" that is over | guard row not released or projection stale | `SELECT * FROM driver_active_assignment WHERE driver_id=…`; the trip's status; the 30 s projection reconcile fixes Redis, **never** edit the guard row without confirming the trip is terminal |
| Pool never closes | `pool-expire-<id>` job missing | reconciler (`poolExpireRearmed` in its report) re-arms; check `matching` queue |
| Postgres disk full / host dead | infrastructure | runbook sections 4 and 7 |
| Data corruption / bad write by a bug | application | restore a copy to a throwaway Postgres with `restore-drill.sh`, compare, repair with a reviewed SQL script; invariants I1–I9 tell you what must hold |
| `migration_conflict` rows | legacy data a migration refused to guess | [database-migrations.md](database-migrations.md) section 5 / runbook section 6 |
| Users suddenly logged out | refresh-token family revoked (replay detected) or sessions invalidated after a restore | expected after a restore (runbook section 4 step 7); otherwise check auth logs for `invalid_refresh_token`, see [state machine 8](../state-machines.md#8-refresh-token-session-family) |

Re-arming a stuck outbox intent by hand (after fixing the cause; one row, Postgres authoritative):

```sql
UPDATE outbox SET processed_at = NULL, failed_at = NULL, attempts = 0, available_at = now(),
                  lease_token = NULL, leased_until = NULL
 WHERE id = '<outbox id>';
```

The relay's next poll (<= 1 s) publishes it; job ids are deterministic so a duplicate is harmless.

## 4. Backups and drills

The `backup` service (prod compose) runs nightly at 21:00 UTC: `pg_dump` custom format piped straight into `age`
(public key only on the VPS), manifest written last, 30 daily + 12 monthly retained, optional S3-compatible offsite
(off by default, **enable before real data**). Markers: `.last_success`, `.last_offsite_success`,
`.last_offsite_failure` (the backup health alert is not wired yet: check them).

| Drill | Command | Cadence |
|---|---|---|
| Backup + restore rehearsal on fixtures | `scripts/recovery/backup-rehearsal.sh` | nightly Jenkins job, 1st of the month |
| Restore drill on a **real** backup | `scripts/recovery/restore-drill.sh --dir <backups> --identity <age identity>` | monthly, from an operator machine that holds the identity (never on the VPS) |
| Redis-loss drill | `scripts/recovery/redis-loss-drill.sh` | after any change to projections, timers or the reconciler |

The restore drill restores into a throwaway Postgres, checks integrity, migrations current, invariants I1–I9 and row
counts, prints PASS/FAIL and exits non-zero on failure; it never touches a running stack or the backup directory.
Record each real drill in the table at runbook section 2 (date, size, restore seconds, total minutes, who).

## 5. Restore, in one screen

Do the real thing from the runbook; this is the map. **Fence the old host first** (two live instances of a restored
database can dispatch the same ride twice).

1. Fresh backup of whatever is left, if the database is still readable.
2. New/empty Postgres (`docker compose … up -d postgres`), `pg_restore` the verified dump, run the `migrator`.
3. **Invalidate sessions** (runbook section 4 step 7) — restored refresh tokens may be unknown to clients.
4. Start redis (empty), api, web, osrm, nginx, certbot; Redis rebuilds from Postgres; drivers re-announce.
5. Smoke, one full journey, fresh backup, then write the timeline.

Full VPS loss: runbook section 7. Known gaps, which you must repeat to the owner rather than assume away: RPO 24 h,
offsite off by default, RTO unmeasured on production-sized data, the age identity's location is the owner's, backup
alerting not wired, and the migration runner can re-run a non-idempotent migration after a crash between its body and
its history record.

## 6. After the incident

- Blameless post-mortem with the timeline; the action items become stories (`/gen-story`).
- If a state machine allowed an impossible state, the fix is a **database constraint or trigger** plus a test with
  independent connections ([testing.md](testing.md) section 4), not another application check.
- Update the runbook where reality differed from it; add the new invariant to the audit SQL in
  `docs/remediation/stage-c-contract.md` section 6.
- Anything touching secrets, an ADR, or a vendor is a HITL decision.
