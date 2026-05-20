---
title: Journey — Client OTP signup
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[personas-client]]
related: [[integration-firebase-phone-auth]], [[module-auth]], [[entity-user]], [[entity-client]], [[journey-client-google-link]]
audience: both
---

# Client OTP signup

*First-time login via phone number + OTP, powered by Firebase Phone Auth.*

## Happy path

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (web)
    participant F as Firebase
    participant API as rcab API
    participant DB as Postgres

    C->>F: reCAPTCHA + sendCode(phone)
    F-->>C: SMS dispatched
    C->>F: verifyCode(otp)
    F-->>C: ID token (JWT, signed by Firebase)
    C->>API: POST /auth/firebase-exchange (ID token)
    API->>F: verifyIdToken(token)
    F-->>API: phone_number, firebase_uid
    API->>DB: SELECT user WHERE firebase_uid = ?
    alt not found
        API->>DB: INSERT user(firebase_uid, phone, role=client)
        API->>DB: INSERT client(user_id, ...)
    end
    API-->>C: { rcab_jwt, refresh_token, user }
```

## Edge cases

- **OTP rate-limit** — Firebase enforces. Surface a clear "try again in N s" message.
- **Wrong phone format** — client-side validation; server still revalidates.
- **Existing account with same phone** — exchange returns existing user (no duplicate created).
- **Network drop after Firebase verify, before our exchange** — the client retains the Firebase ID token (in memory only, never persisted) and retries with exponential backoff. If the token expires (1 h), restart the flow.

## Security notes

- We never store the Firebase ID token. We exchange it once and issue our own short-lived JWT + refresh token.
- The `firebase_uid` is the immutable link. The phone number can change later (port).
- Re-issued JWTs include `auth_method=phone|google` so frontends can prompt re-auth for sensitive actions.

## See also
- [[integration-firebase-phone-auth]] · [[module-auth]]
- [[journey-client-google-link]]
- [[entity-user]] · [[entity-client]]
