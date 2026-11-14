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
| Firebase Admin SDK | `/opt/rcab/compose/env/api.env` (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`) | env — only needed while `phone` is in `AUTH_ENABLED_METHODS` (off until launch, [[ADR-0003-otp-firebase]] amendment 2026-11-10) |
| Google OAuth client IDs (`GOOGLE_CLIENT_IDS`) | `/opt/rcab/compose/env/api.env` | env, comma-separated, public. Accepted ID-token audiences: Web client ID first (the API serves it to clients via `GET /v1/auth/config`), then the Android client ID. `GOOGLE_CLIENT_ID` is a single-value alias. Missing → Google sign-in returns 503 `google_not_configured` |
| Web build fallback (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`) | CI build arg (`scripts/deploy/build-images.sh`) | public; optional, web prefers `/v1/auth/config` |
| Driver-app server client ID (`GOOGLE_SERVER_CLIENT_ID`) | `--dart-define` at `flutter build` | public; the **Web** client ID, optional fallback to `/v1/auth/config` |
| `google-services.json` (driver app) | `apps/driver-app/android/app/` | public config, not a secret; re-download from Firebase after adding Android SHA-1s |
| FCM service account | `/opt/rcab/secrets/fcm.json` (mode 600) | file |
| Backup encryption (age) | `/opt/rcab/secrets/age.key` (mode 600) | file |
| Object storage credentials | `/opt/rcab/compose/env/backup.env` | env |

Files mounted read-only into containers.

## Rotation

- **JWT signing key:** rotate every 90 days. JWKs endpoint at `/.well-known/jwks.json` allows graceful overlap.
- **Database password:** rotate every 180 days.
- **Backup encryption key:** rotate every 365 days, keep old keys for retention period.
- **Firebase / FCM service accounts:** rotate when key revealed or every 365 days.
- **Google OAuth clients:** no client secret is used (ID-token flow only), so nothing to rotate. To replace a client, add the new ID to `GOOGLE_CLIENT_IDS` alongside the old one, ship clients, then remove the old ID. Android clients are keyed by package `com.rcab.driver_app` + signing-key SHA-1; add one per signing key (debug, upload, Play App Signing).

## Not in this scheme

- No `.env` files committed to git. Ever. CI verifies this.
- No secrets in container images.

## Phase-1 upgrade path

- Move to Doppler / SOPS / Vault when team > 3 people.

## See also
- [[vps-topology]] · [[docker-compose]] · [[ci-cd]]
