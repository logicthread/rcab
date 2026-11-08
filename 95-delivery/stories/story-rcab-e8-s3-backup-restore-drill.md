---
title: RCAB-E8.S3 — Backup container + restore drill
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S3
demo: 7
estimate: m
hitl: yes
depends_on: [[backups]], [[story-rcab-e8-s8-review-remediation-stage-c]]
blocks:
affected_notes: [[backups]], [[vps-topology]], [[docker-compose]], [[redis-usage]]
owner: claude
audience: both
---

# RCAB-E8.S3 — Backup container + restore drill

## Goal

Make the Postgres backups correct and, above all, **verifiable**, and prove the two recovery paths the architecture relies on: restoring Postgres from a backup, and rebuilding Redis from Postgres. This is review-remediation item R13 (recovery and backup proof). Branch `rem-e/recovery`.

Policy decision recorded here: **Redis loss affects availability only.** Postgres is the single recovery authority for business state; Redis holds projections, timers and advisory presence that the api rebuilds at boot (pool projection, dispatch reconciler, driver assignment projection).

## Acceptance criteria

- Given the nightly schedule, When the backup runs, Then a `pg_dump -Fc` is written (age-encrypted when a recipients file is mounted, otherwise refused unless `BACKUP_ALLOW_PLAINTEXT=1`) together with a `.sha256` and a `manifest.json`, the manifest being written last; and no plaintext dump is left on the volume.
- Given bad configuration (wrong DB password, private identity mounted as recipients, no recipients file), When the backup runs, Then it exits non-zero with a specific message and leaves no partial backup.
- Given more backups than the policy allows, When a backup completes, Then the newest 30 plus the oldest of each of the newest 12 months are kept and sidecar files are removed with their dump.
- Given `RCLONE_REMOTE` and `RCLONE_CONFIG_<REMOTE>_*` env vars, When the backup runs, Then daily (and, on the 1st, monthly) copies are uploaded and verified; with no `RCLONE_REMOTE` nothing leaves the host and no vendor is required.
- Given a backup directory, When `scripts/recovery/restore-drill.sh` runs, Then it verifies integrity, restores into a throwaway Postgres, reports migration status (applying pending migrations), evaluates invariants I1–I9 and row counts, prints PASS/FAIL, tears down, and exits non-zero on any failure.
- Given a disposable stack, When Redis is flushed and the api restarted (`scripts/recovery/redis-loss-drill.sh`), Then pool projections, BullMQ timers/wake jobs and `current_ride_id` are rebuilt from Postgres and drivers can re-establish presence.
- The runbook `docs/operations/recovery-runbook.md` documents backup location, restore, Redis loss, full VPS loss, the `migration_conflict` resolution procedure, and the RPO/RTO the setup actually provides.

## Technical acceptance criteria

- `infra/docker/backup` image: `backup.sh`, `entrypoint.sh` (cron env snapshot), `crontab` (21:00 UTC, logs to container stdout), `Dockerfile`.
- `infra/docker/env.example/backup.env.example` documents `PGPASSWORD`, age recipient, retention and the env-only rclone remote (placeholders only).
- `infra/docker/docker-compose.recovery-drill.yml` is a separate compose project with loopback-only ports; it never reuses the dev stack's project, network, volumes or ports.
- `scripts/recovery/`: `restore-drill.sh`, `redis-loss-drill.sh`, `backup-rehearsal.sh`, `fixture.sql`, `resolve-driver-conflict.sql`.
- `Jenkinsfile.nightly`: monthly (1st, UTC) rehearsal stage.
- No change to `apps/api/src`.

## Test plan

- Integration (script level, Docker): `scripts/recovery/backup-rehearsal.sh` (guards, encryption, manifest, retention, env-only offsite via rclone local backend, restore from local and retrieved-offsite copies, corrupted-dump and wrong-key rejection).
- Integration: `scripts/recovery/restore-drill.sh` on the rehearsal output (invariants I1–I9, migrations, row counts).
- Integration: `scripts/recovery/redis-loss-drill.sh` against a disposable compose project.
- Manual rehearsal on a throwaway database: legacy double assignment → 0014 → `migration_conflict` → `resolve-driver-conflict.sql` → I1/I2 clean.
- Not covered: fresh-host restore, production-sized RTO, real offsite provider, stale-snapshot (old AOF) restore.

## HITL stops

- **Offsite target**: enabling the optional rclone remote means choosing/paying for an object store (a vendor decision). Default is local volume only.
- **Age key custody**: the owner generates the age identity and keeps it off the VPS; the VPS gets only the public recipient. Changing secrets handling or the `secrets-management` note is out of scope here.
- **RPO acceptance**: ~24 h (nightly dump) must be accepted by the owner for the pilot, or a more frequent dump / PITR scoped.
- **First fresh-host restore drill** with production-sized data (RTO measurement) and sign-off.

## Out of scope

- WAL archiving / point-in-time recovery.
- Migration runner locking and checksums (R13 first half; touches `apps/api/src/migrate.ts`, owned by another change).
- Alerting on a stale `.last_success` (belongs with E8.S2).
- Any deployment to a real VPS.

## Notes / questions

- The prod postgres runs the `postgis/postgis:16-3.4` base; the backup image's `postgresql16-client` must stay at major 16 until the server moves.
- `age.key` in the existing mount path now means "public recipient", enforced by the script.
- Backups predating this story (`*.dump.gz.age`, no manifest) are not accepted by the drill; see the runbook for manual restore.

## See also

- [[epic-e8-production-hardening]] · [[story-rcab-e8-s8-review-remediation-stage-c]]
- [[backups]] · [[vps-topology]] · [[docker-compose]] · [[redis-usage]]
- [[hitl-touchpoints]] · [[commit-story-linkage]]
