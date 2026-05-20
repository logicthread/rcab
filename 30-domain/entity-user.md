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
| firebase_uid | text | unique, **non-null** (we require phone OTP) |
| phone_e164 | text | unique, indexed |
| google_sub | text | unique, nullable — set when Google linked |
| email | text | nullable, never used as primary identifier |
| display_name | text | nullable, sourced from Google or set by user |
| role | enum('client', 'driver') | exclusive in Phase-0 |
| status | enum('active', 'suspended', 'deleted') | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Invariants

- `firebase_uid` is the immutable identity anchor.
- `phone_e164` can change (port). On change, audit row written; Firebase reverifies.
- `role` is set at signup; switching roles is a manual ops action in Phase-0.

## Relationships

- 1:0..1 → [[entity-client]] (only if `role=client`)
- 1:0..1 → [[entity-driver]] (only if `role=driver`)
- 1:N → [[entity-rating]] (as subject)

## See also
- [[entity-client]] · [[entity-driver]]
- [[module-auth]] · [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[schema-postgres]]
