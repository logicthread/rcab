# Recovery runbook

Story RCAB-E8.S3 · guide item R13 (recovery and backup proof). Phase-0 topology: one VPS, one docker-compose (`infra/docker/docker-compose.prod.yml`).

This page is operational. It says what exists, what the drills proved, and what has **not** been proven. Nothing here has been run against a production VPS.

## 1. Recovery authorities

| Data | Authority | If lost |
|---|---|---|
| Rides, pools, members, offers, driver assignment guard, outbox, sessions (`auth_refresh_token`), idempotency | **Postgres** | Restore from backup (section 4). Everything since the last backup is gone (RPO). |
| BullMQ queues (`bull:dispatch|scheduled-dispatch|matching:*`), `pool:<id>` hashes, `driver:state:<id>.current_ride_id`, geo index, presence | **Redis, as a rebuildable projection of Postgres** | Availability only. Restart the api; it rebuilds from Postgres (section 5). No restore needed. |
| OSRM graph | Rebuilt from the OSM PBF (`osrm-prep` / `osrm-extract`) | Re-run the one-shot services. |
| Secrets, age identity | The owner (outside this repo and outside the VPS) | Not recoverable by this runbook. See `80-infrastructure/secrets-management.md`. |

Redis keeps an append-only file in prod, but that is an optimisation for faster restarts, not a guarantee. The recovery guarantee is: with Redis completely empty, a restarted api converges to the right state from Postgres alone (proved by `scripts/recovery/redis-loss-drill.sh`).

## 2. What the backup does

Service `backup` in the prod compose (image from `infra/docker/backup`):

- Cron at **21:00 UTC (02:30 IST)** runs `backup.sh` (the container's cron environment is snapshotted at start, because `crond` does not pass it to jobs).
- `pg_dump --format=custom` piped straight into `age -R` (public recipients). No plaintext dump ever touches disk. Without a recipients file the script **refuses** to run (set `BACKUP_ALLOW_PLAINTEXT=1` for dev only).
- Verification before publishing: the output must be an age v1 file (or, for plaintext dev runs, `pg_restore --list` must list objects), and it must authenticate to Postgres first (`PGPASSWORD`, which must equal `POSTGRES_PASSWORD`).
- Files written to `/opt/rcab/backups` (host path of the `/backups` volume), manifest last so a missing manifest means "incomplete":
  - `rcab-<UTC>.dump.age`
  - `rcab-<UTC>.dump.age.sha256`
  - `rcab-<UTC>.manifest.json` (sha256, size, server version, `last_migration`, encryption flag)
- Marker files: `.last_success`, `.last_offsite_success`, `.last_offsite_failure`.
- A free-space check (`BACKUP_MIN_FREE_MB`, default 1024) and a lock prevent a full disk or overlapping runs from corrupting anything. Temp files live in `.tmp-<ts>/` and are removed on exit.
- **Local retention** (`BACKUP_KEEP_DAILY=30`, `BACKUP_KEEP_MONTHLY=12`): the newest 30 backups, plus the oldest backup of each of the newest 12 calendar months (UTC). Dump, `.sha256` and manifest are removed together. The newest backup is never removed.
- **Optional offsite** (off by default): set `RCLONE_REMOTE`, `RCLONE_BUCKET` and the `RCLONE_CONFIG_<REMOTE>_*` variables in `backup.env` (see `infra/docker/env.example/backup.env.example`). Any S3-compatible store works; no vendor is required. Uploads go to `<prefix>/daily/`, and to `<prefix>/monthly/` on the run whose UTC date is the 1st. Every upload is checked with `rclone check`; a failure exits 2, keeps the local copy and writes `.last_offsite_failure`. Remote retention is time-based (`RCLONE_KEEP_DAILY_DAYS=30` days of dailies, about 12 months of monthlies; disable with `RCLONE_PRUNE=0` and use bucket lifecycle rules instead).

### Age keys

`/opt/rcab/secrets/age.key` (mounted at `/run/secrets/age.key`) must contain only the **public** recipient (`age1...`). The script refuses a file containing `AGE-SECRET-KEY-`. The matching identity is created once, elsewhere, and kept by the owner **off the VPS** (a password manager plus an offline copy). Without that identity every encrypted backup is unreadable. Test that you can find it before you need it.

```
age-keygen -o rcab-backup.identity                           # on an operator machine; store safely
age-keygen -y rcab-backup.identity > /opt/rcab/secrets/age.key   # public part only, onto the VPS
```

### RPO and RTO this setup actually gives

| | Value | Why |
|---|---|---|
| **RPO** | **up to ~24 h** of Postgres writes (rides, payments data, sessions) | One nightly logical dump. No WAL archiving / PITR. With offsite enabled the dump is off the host within minutes of finishing; **without offsite, losing the VPS disk loses the backups too** (local volume only). The pilot owner must accept this explicitly or fund a more frequent dump / PITR. |
| **RTO** | **Not proven for production.** The database restore step measured **1 s on the fixture** (a 63 KB dump); it grows with data size and is only one part of recovery. | Full recovery also needs a fresh host, Docker, image pull/build, retrieving the dump and the identity, migrations, TLS/DNS cutover. The `<30 min` goal in `80-infrastructure/backups.md` stays a target until the monthly drill is run on production-sized data on a fresh host and the numbers are recorded below. |

Record each real drill here (date, dump size, restore seconds, total minutes, who):

| Date | Dump size | Restore | Whole drill | Notes |
|---|---|---|---|---|
| 2026-11-08 | 63 KB (fixture) | 1 s | 10 s | Rehearsal on fixture data only (`backup-rehearsal.sh`), not a production figure |

## 3. Drills (what to run, how often)

| Drill | Command | Needs | Proves |
|---|---|---|---|
| Backup + restore rehearsal on fixtures | `scripts/recovery/backup-rehearsal.sh` | docker | The real backup image, encryption, guards, retention, env-only offsite, restore from local and retrieved-offsite copies, corruption and wrong-key detection. No secrets. Wired into `Jenkinsfile.nightly` on the 1st of each month. |
| Restore drill on a **real** backup | `scripts/recovery/restore-drill.sh --dir /opt/rcab/backups --identity /path/to/identity` | docker; the age identity | The newest real backup passes integrity, restores into a throwaway Postgres, migrations are current, invariants I1-I9 hold, row counts. Prints PASS/FAIL, exits non-zero on failure. |
| Redis-loss drill | `scripts/recovery/redis-loss-drill.sh` | docker, network (first run pulls `tsx` via `npx`) | FLUSHALL + api restart rebuilds projections, timers and assignment state from Postgres. Uses its own compose project and loopback ports 13000/15432/16379 (override with `--api-port/--pg-port/--redis-port`). |

Monthly cron for the real-backup drill. The identity must **not** live on the VPS, so run it from an operator machine or CI that has read access to a copy of the backups (offsite or `rsync`ed):

```
# crontab on the operator machine: 06:00 on the 2nd of each month
0 6 2 * * cd /path/to/rcab && AGE_IDENTITY_FILE=$HOME/.rcab/backup.identity BACKUP_DIR=$HOME/rcab-backups-copy scripts/recovery/restore-drill.sh >> $HOME/rcab-restore-drill.log 2>&1 || mail -s "rcab restore drill FAILED" you@example.com < $HOME/rcab-restore-drill.log
```

The drill reads the dump but never modifies the backup directory, never connects to any running stack, and removes its container on exit (even on failure).

Backups from before RCAB-E8.S3 (`*.dump.gz.age`, no manifest) are not accepted by the drill. Restore one by hand: `age -d -i identity < file | gunzip | pg_restore ...`.

## 4. Restore Postgres (single VPS)

Use this for data loss/corruption on a host that otherwise works. Everything since the chosen backup is lost; decide that consciously.

1. **Stop writers and fence.** `docker compose -f infra/docker/docker-compose.prod.yml stop nginx api web` (nginx first, so no traffic is taken). Leave `postgres` and `redis` running.
2. **Pick and verify the backup.** Newest complete one: `ls -1 /opt/rcab/backups/rcab-*.manifest.json | sort | tail -1`. Check the checksum: `cd /opt/rcab/backups && sha256sum -c rcab-<ts>.dump.age.sha256`. Prefer to dry-run it first with `scripts/recovery/restore-drill.sh --backup <file> --identity <identity>`.
3. **Keep the damaged database** in case you need it: `docker compose exec postgres psql -U rcab -d postgres -c "ALTER DATABASE rcab RENAME TO rcab_damaged_$(date +%Y%m%d)"` (terminate sessions first if needed), then `createdb -U rcab rcab`. Do not drop it until the restored system is verified.
4. **Restore** (the identity is read from the operator's machine and piped, so it never touches the VPS disk; the dump is decrypted in memory):

   ```
   age -d -i ~/.rcab/backup.identity < rcab-<ts>.dump.age \
     | docker compose -f infra/docker/docker-compose.prod.yml exec -T postgres \
         pg_restore --no-owner --no-privileges -U rcab -d rcab
   ```
   The dump carries its own `CREATE EXTENSION` statements (`postgis`, ...), so restore into a freshly created, empty database (this is exactly what the drill does). Restoring over a database that already has data will fail.
5. **Migrate forward**: `docker compose -f infra/docker/docker-compose.prod.yml run --rm migrator`. The restore drill does the same against the restored copy and fails if a pending migration fails on the data.
6. **Review `migration_conflict`** (section 6) and the invariants: run `scripts/recovery/restore-drill.sh --no-migrate --backup <file> --identity <identity>` to see I1-I9, or run the queries in `docs/remediation/stage-c-contract.md` section 6 against production.
7. **Invalidate sessions** (a restore resurrects refresh tokens that were revoked after the backup, for example after a logout or a suspension):

   ```sql
   UPDATE auth_refresh_token SET revoked_at = now() WHERE revoked_at IS NULL;
   ```
   Every user must sign in again. Access tokens live 15 minutes. If you must cut them off immediately, rotate the JWT signing secret (a secrets-handling change that needs the owner and the `secrets-management` procedure).
8. **Flush Redis** (stale state from before the restore must not be trusted): `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" FLUSHALL`, then start `api`, `web`, `nginx`. The api rebuilds Redis from the restored Postgres (section 5).
9. **Verify**: `pnpm prod:test`-style smoke (`/v1/health/ready`), then walk one journey (login, book, driver accepts) before announcing recovery. Tell drivers to go online again.

## 5. Redis loss (flush, crash without AOF, bad restore)

Redis loss affects availability, not correctness. Symptoms: no drivers appear online, offers/timers do not fire, pool pages show stale state.

1. Restart the api: `docker compose -f infra/docker/docker-compose.prod.yml restart api`. At boot:
   - `PoolProjectionService` rebuilds every `pool:<id>` hash from `shared_rides` + `pool_member`.
   - `DispatchReconciler` re-arms, from trip rows and the outbox: scheduled-ride wake jobs, pool expiry timers, dispatch start / wave-2 / hard-fail timers. It runs again every 5 minutes.
   - `DriverAssignmentProjection` re-projects `current_ride_id` from `driver_active_assignment` onto every driver whose presence hash exists, every 30 s.
2. **Presence is advisory and is not restored.** Drivers reappear when their app calls `POST /v1/drivers/online` again (or reconnects). The auto-offline sweep never resurrects anyone. Ask drivers to toggle online if the app does not do so itself.
3. Do not delete Postgres rows or "cancel stuck rides" to unstick things; wait one reconcile cycle (about 5 minutes) first. A late timer is validated by the dispatch worker's generation and state guards.

`scripts/recovery/redis-loss-drill.sh` result (2026-11-08, fixture data, own compose project, dev stack untouched): all 12 checks passed. After `FLUSHALL` (`DBSIZE` 0) and an api restart, `pool:<id>` was rebuilt, `pool-expire`, `scheduled-wake` and `dispatch-wave2`/`dispatch-hardfail` jobs reappeared, two outbox rows were re-published, presence came back through `POST /v1/drivers/online`, `current_ride_id` was re-projected, and a checksum of the authoritative Postgres rows was identical before and after.

Limits of that proof: it exercises the api with no real driver sockets, no OSRM and a tiny data set; it does not test Redis being restored from an **old** snapshot (a stale AOF), which the reconciler also handles in code but which this drill does not exercise.

## 6. Resolving `migration_conflict` rows

Migration 0014 gives every driver with exactly one active trip a `driver_active_assignment` guard. A driver who already held **more than one** active trip (the pre-Stage-C double-assignment bug), or whose `driver` row is missing, gets **no guard row** and is recorded in `migration_conflict`. Nothing was cancelled. Until you resolve it, that driver's trips run without exclusivity protection, and invariants I1/I2 report them. `0016` records pool membership problems the same way.

List what is open:

```sql
SELECT id, migration, kind, subject, detail, detected_at
  FROM migration_conflict WHERE resolved_at IS NULL ORDER BY id;
```

### `driver_multiple_active_trips` (0014)

`detail.trips` lists the driver's trips (`trip_kind`, `trip_id`, `assigned_at`). **A person decides** which single trip stays with the driver (usually the one in progress or the newest; ask the driver / support). Then, taking a fresh backup first:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v driver_id=<driver uuid> \
  -v keep_kind=solo            `# or: shared` \
  -v keep_trip=<trip id to KEEP> \
  -v drop_trip=<solo ride id to CANCEL> \
  -f scripts/recovery/resolve-driver-conflict.sql
```

The script runs in one transaction and aborts on any failed assertion. It (1) checks the conflict is open and the kept trip is the driver's active trip, (2) inserts the `driver_active_assignment` guard row for the kept trip, (3) cancels the other **solo** ride (`status='cancelled'`, `cancelled_by='driver'`, reason `migration_conflict: ...`), (4) marks the `migration_conflict` row resolved. The core statements, if you ever need to do it by hand:

```sql
-- keep a SOLO ride:
INSERT INTO driver_active_assignment (driver_id, solo_ride_id, dispatch_generation, assigned_at)
SELECT driver_id, id, GREATEST(dispatch_generation,1), COALESCE(accepted_at, updated_at)
  FROM rides WHERE id = :'keep_trip' AND driver_id = :'driver_id';
-- keep a POOL instead:
INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation, assigned_at)
SELECT claimed_by_driver_id, ride_id, GREATEST(dispatch_generation,1), COALESCE(claimed_at, updated_at)
  FROM shared_rides WHERE ride_id = :'keep_trip' AND claimed_by_driver_id = :'driver_id';
-- cancel the extra solo ride:
UPDATE rides SET status='cancelled', cancelled_at=now(), cancelled_by='driver',
       cancel_reason='migration_conflict: duplicate driver assignment', updated_at=now()
 WHERE id = :'drop_trip' AND driver_id = :'driver_id'
   AND status IN ('accepted','en_route','arrived','in_progress');
UPDATE migration_conflict SET resolved_at = now(), resolution = '<what you decided>'
 WHERE kind='driver_multiple_active_trips' AND subject->>'driver_id' = :'driver_id' AND resolved_at IS NULL;
```

Rules: the guard row table has `driver_id` as its primary key, so a second guard for the same driver is rejected by the database. **Never cancel a pool by SQL**: its members, seat count, outbox intent and Redis projection are application-owned. If the extra trip is a pool, keep the pool and cancel the solo ride, or release the pool through the application. The passenger of a cancelled ride is not notified by SQL; contact them. Redis `current_ride_id` is corrected by the 30 s projection reconcile.

Rehearsed on a throwaway database (legacy rows with two double-assigned drivers: one solo+solo, one solo+pool; migrations 0014-0017 applied): both conflicts listed, I1/I2 flagged the unguarded trips before, 0 violations after, the guard rows were created, the extra rides were cancelled, and a second guard row for the same driver was rejected by the primary key.

### `assignment_unknown_driver` (0014)

An active trip points at a driver id with no `driver` row. Either restore the missing driver (and then insert the guard as above), or cancel the trip with the same `UPDATE` and resolve the row by hand. Do not invent a driver.

### `pool_*` and `passenger_multiple_active_pools` (0016)

Read the `detail` column (it holds the original entries). Typical resolutions: re-create a missing user, keep the newest membership (already done by the migration; the older, deactivated rows stay recorded), or accept a raised `max_seats` / corrected `seat_count`. Mark each resolved with `UPDATE migration_conflict SET resolved_at = now(), resolution = '...' WHERE id = ...`. The restore drill lists open rows as a warning and treats I6 rows belonging to an open `passenger_multiple_active_pools` conflict as expected.

## 7. Full VPS loss (new host)

Prerequisites kept **off** the lost host: the repository, the compose `.env`/`api.env`/`postgres.env`/`backup.env` values (secrets store), the age identity, and a copy of the backups (offsite bucket or an `rsync`ed copy). If you have none of these, recovery is not possible; that is what offsite is for.

1. **Fence the old host.** If it is reachable, stop its stack. If it is not reachable but could come back (provider outage rather than destruction), do not point DNS at the new host until the old one is confirmed destroyed or powered off, or you risk two instances dispatching the same restored rides. Revoke its access to the shared services (Firebase keys, OSRM, storage credentials) if you cannot confirm it is gone.
2. **Provision** the new VPS: Docker/Compose, the repo checkout at the release you want, the env files under `/opt/rcab/compose/env/`, `/opt/rcab/secrets/`. Do not start the full stack yet.
3. **Fetch the backup** (offsite bucket `<prefix>/daily/` or `/monthly/`, dump + `.sha256` + manifest) and verify `sha256sum -c`.
4. **Dry-run on a laptop first if time allows**: `scripts/recovery/restore-drill.sh --dir <fetched dir> --identity <identity>`. A PASS here means the data restores and the invariants hold.
5. `docker compose -f infra/docker/docker-compose.prod.yml up -d postgres` and wait for health. Restore as in section 4, steps 4-5 (empty database, `pg_restore`, then the `migrator`).
6. Section 4 step 7: invalidate sessions.
7. Start `redis` (empty is fine), then `api`, `web`, `osrm-*` (rebuilds the graph; this takes minutes), `nginx`, `certbot`. TLS certificates are issued fresh by certbot on the new host (DNS must point there first, which is the cutover, after fencing).
8. Section 5: Redis rebuilds itself; drivers re-announce presence.
9. Smoke and one full journey. Then re-enable the backup service and **take a fresh backup immediately** (`docker compose exec backup /usr/local/bin/backup.sh`) so the new host is protected.
10. Write down the timeline (detect, decide, restore start/end, cutover). That is the measured RTO.

## 8. Known gaps (owner decisions or follow-ups)

- **RPO 24 h** is a business decision. Reduce it with a more frequent dump (change the crontab) or WAL archiving / PITR (new scope).
- **Offsite is optional and off by default.** With local-only backups a disk failure loses the backups. Enable it before the pilot carries real data.
- **RTO is unmeasured** on production-sized data on a fresh host.
- **The age identity location** is the owner's: nothing in the repo can enforce that it is backed up separately.
- The migration runner (`apps/api/src/migrate.ts`) now serialises concurrent runs with a session-level Postgres advisory lock (`pg_advisory_lock`), but it still records history in a separate statement from the migration body (not one transaction; guide R13). A crash between the two can re-run a non-idempotent migration, so write migrations to be re-runnable or wrap them in `BEGIN/COMMIT` yourself. The restore drill applies pending migrations the same way and does not exercise two concurrent migrators.
- The backup healthcheck/alerting is not wired: check `.last_success` / `.last_offsite_failure`, or add an alert (follow-up for S2).
