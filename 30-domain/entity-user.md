---
title: Entity — User
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[data-model]]
related: [[entity-client]], [[entity-driver]], [[integration-firebase-phone-auth]], [[integration-google-account-link]], [[module-auth]]
audience: both
---

# User

*Auth-level record. One per real person.*

## Fields

| Field | Type | Notes |
|---|---|---|
| id | uuid (v7) | pk |
| firebase_uid | text | unique, **nullable since 0018**; set only for Firebase-phone-registered users, NULL for Google-registered ones (NULLs never clash under UNIQUE) |
| phone_e164 | text | unique, indexed; **nullable since 0018** (Google-only sign-in, 2026-11-10) |
| google_sub | text | unique (0018 asserts the index), nullable — identity for Google-registered users; `CHECK app_user_identity_check (phone_e164 IS NOT NULL OR google_sub IS NOT NULL)` |
| email | text | nullable, Google-verified email (refreshed on each Google sign-in); not unique; never used as primary identifier or to auto-link. Operators look accounts up by it ([[module-auth]], `scripts/provision-driver.sh`) |
| display_name | text | nullable, sourced from Google or set by user |
| role | enum('client', 'driver') | exclusive in Phase-0 |
| status | enum('active', 'suspended', 'deleted') | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Invariants

- Every account has at least one login identity: `phone_e164` or `google_sub` (enforced by `app_user_identity_check`, migration 0018). Google accounts are matched by `google_sub` only, never by email.
- `firebase_uid`, when present, is the immutable anchor of a phone account; it is NULL for Google-registered users.
- `phone_e164` can change (port). On change, audit row written; Firebase reverifies.
- `role` is set at signup (always `client` for a Google or phone first sign-in); switching to `driver` is an operator action in Phase-0: `scripts/provision-driver.sh <email>`. The API reads `role` from this table on every token refresh, so it takes effect at the next refresh.

## Relationships

- 1:0..1 → [[entity-client]] (only if `role=client`)
- 1:0..1 → [[entity-driver]] (only if `role=driver`)
- 1:N → [[entity-rating]] (as subject)

## See also
- [[entity-client]] · [[entity-driver]]
- [[module-auth]] · [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[schema-postgres]]
