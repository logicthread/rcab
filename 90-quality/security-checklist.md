---
title: Security checklist
tags: [layer/quality]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[secrets-management]], [[api-conventions]], [[module-auth]]
audience: both
---

# Security checklist

*Phase-0 baseline. Each item is either green, in-progress, or red.*

## Auth

- [ ] All endpoints behind `AuthGuard` except `/v1/auth/*` and `/v1/health/*`.
- [ ] JWT `exp` ≤ 15 min; refresh tokens rotated on use.
- [ ] Refresh tokens stored hashed in DB; revoked on logout.
- [ ] Role enforcement via `RolesGuard` on every driver-only / client-only route.
- [ ] Firebase ID token never persisted server-side.

## Transport

- [ ] TLS 1.2+ only.
- [ ] HSTS on.
- [ ] Cookies: `HttpOnly`, `Secure`, `SameSite=Lax` for refresh; no other sensitive cookies.

## Input

- [ ] All DTOs validated by `class-validator`; `whitelist: true, forbidNonWhitelisted: true`.
- [ ] Body size capped (1 MB).
- [ ] File uploads — N/A in Phase-0.

## DB

- [ ] No string concat for SQL; ORM-only.
- [ ] Postgres roles: `app_user` (limited), `migrator` (DDL), `replicator` (Phase-1).
- [ ] Encryption at rest at the host level (LUKS).

## Secrets

- [ ] See [[secrets-management]]. No secrets in repo, image, or env in `git`.
- [ ] Rotation cadence defined and tracked.

## Rate limits

- [ ] nginx edge per-IP (`limit_req`).
- [ ] Per-user app-level on writes.

## Logging

- [ ] No PII in logs (phone, email, name redacted).
- [ ] Auth tokens never logged.
- [ ] `request_id` propagated.

## Driver app

- [ ] No tokens in WebView (we don't ship WebViews; native screens only).
- [ ] FCM data payloads contain identifiers, not PII.

## Web app

- [ ] CSP: default-src 'self'; allow OSM tile host, Firebase auth host, Google IdP host.
- [ ] No `dangerouslySetInnerHTML` from user-controlled content.
- [ ] Refresh cookie HttpOnly.

## Operational

- [ ] SSH key-only; root login disabled.
- [ ] UFW deny-by-default.
- [ ] fail2ban for SSH.
- [ ] Container images pinned by digest in compose.
- [ ] Dependabot / renovate for dependencies; weekly review.

## Sensitive

- [ ] Manual deletion endpoint (right-to-delete) by ops on request; soft-delete in Phase-0, hard-delete in Phase-1.

## See also
- [[secrets-management]] · [[api-conventions]] · [[module-auth]]
- [[testing-strategy]]
