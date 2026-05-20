---
title: Backups
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[vps-topology]]
related: [[docker-compose]], [[secrets-management]]
audience: both
---

# Backups

*Nightly logical dumps off-host; weekly full snapshots; tested restores monthly.*

## What we back up

- **Postgres:** `pg_dump --format=custom` nightly at 02:30 IST → gzip → uploaded to S3-compatible object storage (B2 or DO Spaces). Retention: 30 daily, 12 monthly.
- **Redis:** *not* backed up — recoverable from Postgres + driver app reconnects.
- **OSRM data:** the India PBF is rebuilt monthly from upstream; we keep one prior version.
- **Application logs:** Loki retention 14 days; older logs uploaded to cold storage if needed.

## Encryption at rest

- Dump files encrypted with `age` before upload. Key kept in [[secrets-management]] separately from the storage credentials.

## Restore drill

- Once a month, ops spins up a throwaway VPS, restores last night's dump, runs the smoke test suite, then destroys the box.
- Target: < 30 min RTO, < 24 h RPO.

## See also
- [[vps-topology]] · [[docker-compose]] · [[secrets-management]]
