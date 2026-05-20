---
title: Secrets management
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[vps-topology]]
related: [[docker-compose]], [[ci-cd]]
audience: both
---

# Secrets management

*Phase-0: simple, explicit, rotatable. No vault product yet.*

## Where secrets live

| Secret | Location | Format |
|---|---|---|
| Postgres password | `/opt/rcab/compose/env/postgres.env` (mode 600) | env |
| API DB URL | `/opt/rcab/compose/env/api.env` | env |
| JWT signing key | `/opt/rcab/compose/env/api.env` | env (RS256 private key path) |
| Firebase Admin SDK | `/opt/rcab/secrets/firebase-admin.json` (mode 600) | file |
| Google OAuth client ID | `/opt/rcab/compose/env/api.env` | env (public-ish) |
| FCM service account | `/opt/rcab/secrets/fcm.json` (mode 600) | file |
| Backup encryption (age) | `/opt/rcab/secrets/age.key` (mode 600) | file |
| Object storage credentials | `/opt/rcab/compose/env/backup.env` | env |

Files mounted read-only into containers.

## Rotation

- **JWT signing key:** rotate every 90 days. JWKs endpoint at `/.well-known/jwks.json` allows graceful overlap.
- **Database password:** rotate every 180 days.
- **Backup encryption key:** rotate every 365 days, keep old keys for retention period.
- **Firebase / FCM service accounts:** rotate when key revealed or every 365 days.

## Not in this scheme

- No `.env` files committed to git. Ever. CI verifies this.
- No secrets in container images.

## Phase-1 upgrade path

- Move to Doppler / SOPS / Vault when team > 3 people.

## See also
- [[vps-topology]] · [[docker-compose]] · [[ci-cd]]
