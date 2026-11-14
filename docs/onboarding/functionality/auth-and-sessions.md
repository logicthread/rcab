# Auth and sessions

**Google-only until launch (RCAB-E8.S15, owner decision 2026-11-10).** A Google ID token, verified directly with Google, is exchanged for first-party JWTs, with single-use refresh-token rotation. Two session contracts share one service: a **web** contract (HttpOnly cookie + CSRF check) and a **native** contract (JSON tokens in secure storage) used by the driver app.

Back to [README](../README.md) · system context in [01-system-overview](../01-system-overview.md) · session state diagram in [state-machines](../state-machines.md).

## Sign-in methods (current)

- Policy knob `auth.enabledMethods` (env `AUTH_ENABLED_METHODS`, comma list over `google`, `phone`; default `google`) decides what is allowed. Clients read `GET /v1/auth/config` (public) -> `{ methods, google: { clientId } }` and render only enabled methods.
- **Google (enabled):** web `POST /v1/auth/google` (sets the refresh cookie) and native `POST /v1/auth/native/google` take `{ id_token }`. Any Google account with `email_verified=true` is accepted; the audience must be in `GOOGLE_CLIENT_IDS`. Login is by `google_sub`; an unknown sub registers a `client` (never auto-linked by email). The driver role is still provisioned out of band. Errors: `google_token_invalid` (401), `google_email_unverified` (403), `google_not_configured` (503, dev without a client id), `account_disabled` (403).
- **Phone OTP (disabled, not deleted):** while `phone` is not enabled both `firebase-exchange` routes return 403 `auth_method_disabled`. The section below describes that path; it returns when the launch OTP provider (Firebase, MSG91 or other) is chosen. See ADR-0003 amendment.
- Users no longer always have a phone: `phone_e164` is nullable (migration 0018), with a check that a phone or a `google_sub` exists.

## What it does (phone path, disabled until launch)

1. The client proves phone ownership to **Firebase** (SMS code) and gets a Firebase ID token.
2. The API verifies the ID token with `firebase-admin`, upserts the user and mints an **access JWT** (15 min) plus an opaque **refresh token** (30 days).
3. The access token goes in `Authorization: Bearer` on every REST call and in the Socket.IO handshake. The refresh token is rotated on every use.
4. Logout revokes the refresh token. Replaying an old refresh token revokes the whole session family.

`google/login` is folded into `POST /v1/auth/google`; `google/link` stays for the phone-enabled era and is not called by the clients.

## User-visible behaviour

| Surface | Behaviour |
|---|---|
| Web `/signin` | "Continue with Google" (Google Identity Services), rendered from `GET /v1/auth/config`; the phone-then-code form (invisible reCAPTCHA) appears only if `phone` is enabled. On success the user lands on `/book`. Errors appear in a `role="alert"` line. Already signed in: redirected to `/book`. Videos W02, W01 |
| Web reload | The access token lives **in memory only** (Zustand). On reload `withAuth` calls `POST /v1/auth/refresh` with the cookie; no cookie or a rejected refresh sends the user to `/signin`. Video W09 |
| Web sign out | Local state is cleared first, then the server revokes the refresh token and clears the cookie. A refresh is done first if the access token is expired, because logout itself needs a valid bearer. Video W10 |
| Driver app sign-in | "Continue with Google" screen driven by `/v1/auth/config` (`lib/features/auth/sign_in_screen.dart`); a signed-in account whose role is not `driver` lands on "Not registered as a driver yet" (`not_a_driver_screen.dart`: shows the email, Sign out, Retry), see Provisioning a driver below. Tokens go to `flutter_secure_storage`. A rejected refresh signs the driver out. Video D01 |

Scene IDs: web [W01, W02, W09, W10](../videos/web/INDEX.md), driver app [D01](../videos/driver/INDEX.md).

## Provisioning a driver

A Google sign-in always registers a `client`, so a driver account is enabled by an operator after the person has signed in once with Google:

```bash
scripts/provision-driver.sh driver@example.com --vehicle-reg AS01AB1234 --dry-run   # preview
scripts/provision-driver.sh driver@example.com --vehicle-reg AS01AB1234             # dev compose postgres
scripts/provision-driver.sh driver@example.com --database-url postgres://...        # any other database
```

It matches `app_user.email` case-insensitively, refuses an unknown, ambiguous (several accounts share the email) or non-active account, sets `role='driver'`, inserts the `driver` row, removes the unused `client` row (kept when the user has rides as a passenger) and optionally creates a starter vehicle. It is idempotent. The role reaches the user at the **next token refresh**: `POST /v1/auth/native/refresh` (and the web refresh) read `app_user.role` from the database, so the driver taps **Retry** on the "Not registered as a driver yet" screen, or waits up to 15 minutes for the access token to expire; an access token already issued keeps the old `role` claim until then. Follow-up (not built): an admin endpoint to do this without database access.

## API endpoints

| Endpoint | Auth | Purpose and notes |
|---|---|---|
| `POST /v1/auth/firebase-exchange` | public, throttled | Body `{ id_token }`. Returns `{ access_token, token_type, expires_in, user }` and sets the refresh cookie. The refresh token is **not** in the JSON |
| `POST /v1/auth/refresh` | cookie + `CsrfGuard` | Reads the cookie `refresh_token` (a body `refresh_token` is also accepted). Single-use rotation. Sets the successor cookie |
| `POST /v1/auth/logout` | Bearer + `CsrfGuard` | 204. Revokes the presented token (must belong to the caller) and clears the cookie |
| `POST /v1/auth/native/firebase-exchange` | public, throttled | Same exchange; returns `refresh_token` in JSON; sets no cookie |
| `POST /v1/auth/native/refresh` | possession of refresh token | Body `{ refresh_token }` (max 512 chars). Returns a full token set |
| `POST /v1/auth/native/logout` | possession of refresh token, throttled | 204 always (no token-existence oracle). Works after the access token expired |
| `POST /v1/auth/google/login` | public | Body `{ google_id_token }`; 401 `not_found` if no account is linked |
| `POST /v1/auth/google/link` | Bearer | Links a Google `sub` + email; 409 `google_already_linked` if linked to another user |

Error codes: `google_token_invalid`, `google_email_unverified`, `google_not_configured`, `auth_method_disabled`, `invalid_firebase_token`, `invalid_refresh_token`, `account_disabled` (403 on exchange, 401 on refresh), `csrf_rejected` (403), `unauthorized`, `google_already_linked`, `not_found`. The envelope is always `{ "error": { "code", "message", "request_id" } }`.

Contract fixture shared by API and driver app: `apps/api/test/fixtures/native-auth-contract.json` and `apps/driver-app/test/fixtures/native_auth_contract.json` (kept in step by `native-contract-parity.spec.ts`).

## Token model

| Token | Format | Lifetime | Stored |
|---|---|---|---|
| Access | HS256 JWT, claims `sub, role, auth_method, typ=access`, `iss=rcab`, `aud=rcab-api` | `ACCESS_TOKEN_TTL_S`, default 900 s | Web: memory. Driver: secure storage |
| Refresh | 32 random bytes, base64url | `REFRESH_TOKEN_TTL_MS`, default 30 days | Web: HttpOnly cookie `refresh_token` (`SameSite=Lax`, `Path=/v1/auth`, `Secure` only when `NODE_ENV=production`). Driver: secure storage. DB: **only the SHA-256 hex digest** (`auth_refresh_token.token_hash`) |
| Quote | HS256 JWT, `iss=rcab-quote` | 5 min | Not a session token. Same signing secret, different issuer, so it can never pass as an access token |

Rotation rules (`AuthService.refresh`, all in one transaction):

- The validity check and the consumption are a single conditional `UPDATE ... SET revoked_at = now()`, so of N concurrent presenters exactly one wins.
- A token presented again **within `REFRESH_REUSE_GRACE_S` (10 s)** of being consumed gets a plain 401 and the family is left alone (a racing second request or a lost response). Reuse **after** the grace is treated as replay and revokes every live token of the `family_id`.
- A user whose `app_user.status` is `suspended` or `deleted` cannot exchange or refresh; refresh additionally revokes all of that user's live tokens.
- A new login starts a new `family_id`; each rotation keeps it.

Web CSRF posture: refresh and logout require `Origin` (or, if absent, `Referer`) to be in the `CORS_ORIGINS` allowlist; with neither header the request is allowed (non-browser, carries no ambient cookie). Native routes read no cookie and need no CSRF check.

Startup validation (`common/guards/auth-config.ts`): outside `NODE_ENV=development|test` the API refuses to start unless `JWT_SECRET` is at least 32 bytes, non-placeholder and non-trivial, and `CORS_ORIGINS` is an explicit https list (no wildcard). In dev an empty secret falls back to a public dev value and the cookie is set without `Secure`.

User creation: the first successful exchange creates `app_user` (role `client`, status `active`) and a `client` row in one transaction. A driver account is **not** created this way; see [driver-onboarding-and-presence](driver-onboarding-and-presence.md).

## Realtime auth

Socket.IO authenticates in `handleConnection`: token from `handshake.auth.token` or an `Authorization: Bearer` header, verified with the same access-token verifier. Invalid or missing token: disconnect. The socket joins `user:<id>` (and `driver:<id>` for drivers). The web passes the token as a callback so every reconnect uses a fresh one.

## Data

`app_user` (role `client|driver`, status `active|suspended|deleted`, unique `firebase_uid` and `phone_e164`, optional `google_sub`, `email`), `client`, `auth_refresh_token` (migrations 0002, 0012). Refresh revocation is a Postgres column, not a Redis set.

## Policy knobs

[Sessions and auth](../../POLICY.md#sessions--auth): `ACCESS_TOKEN_TTL_S`, `REFRESH_TOKEN_TTL_MS`, `REFRESH_REUSE_GRACE_S`, `FIREBASE_TOKEN_MAX_AGE_S` (Firebase token `iat` must be younger than 1 h). [Rate limits](../../POLICY.md#rate-limits): `THROTTLE_AUTH_LIMIT` / `THROTTLE_AUTH_WINDOW_MS` (10 per minute) apply to the two exchange routes and native logout; `refresh`, `logout`, `native/refresh` and the Google routes use the global 1000 per minute default. Web client knob: `auth.tokenRefreshMarginMs` (refresh 30 s before expiry), see [Client knobs](../../POLICY.md#client-knobs).

## Code entry points

- API: `apps/api/src/modules/auth/auth.controller.ts`, `auth.service.ts`; `common/guards/{auth.guard,access-token,auth-config,csrf.guard}.ts`; `common/utils/cookie.ts`; `infra/firebase/firebase-admin.service.ts`; `infra/google/google-verifier.service.ts`.
- Web: `apps/web/src/lib/auth/{store,firebase,with-auth}.ts(x)`, `apps/web/src/app/signin/sign-in-client.tsx`.
- Driver app: `lib/core/auth/{auth_notifier,token_store,native_auth_contract}.dart`, `lib/core/api/api_client.dart` (`JwtRefreshInterceptor`: single-flight refresh on 401, one retry), `lib/features/auth/sign_in_screen.dart`.

## Tests

- Unit: `auth.service.spec.ts`, `auth.controller.spec.ts`, `native-contract-parity.spec.ts`, `access-token.spec.ts`, `auth-config.spec.ts`, `auth.guard.spec.ts`, `csrf.guard.spec.ts`, `cookie.spec.ts`, `firebase-admin.service.spec.ts`, `google-verifier.service.spec.ts`.
- Integration: `apps/api/test/integration/auth.int.spec.ts` (rotation, replay, grace, concurrency, suspended users).
- Web: `store.test.ts`, `with-auth.test.tsx`, `app/signin/page.test.tsx`; Playwright `apps/web/e2e/signin.e2e.spec.ts`.
- Driver app: `test/features/auth/`, `test/core/api/jwt_refresh_interceptor_test.dart`, `test/routing/app_router_test.dart`.

## Operating notes

- Dev sign-in (current): Google only. Create an OAuth client and set `GOOGLE_CLIENT_IDS` / `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, see [RUN-GUIDE](../../manual-testing/RUN-GUIDE.md) section 3. Without a client id the api returns 503 `google_not_configured`.
- Phone path, only when re-enabled and without SMS (dev, demos): add **test phone numbers** with fixed codes in the Firebase console, or use a pre-minted `FIREBASE_PHONE_TEST_TOKEN` for curl-only checks ([RUN-GUIDE](../../manual-testing/RUN-GUIDE.md) section 3). Seeded fixture users have synthetic `firebase_uid`s and cannot sign in.
- Suspend a user: `UPDATE app_user SET status = 'suspended' WHERE id = ...`. Their next refresh fails and revokes their tokens; an access token already issued stays valid until it expires (at most 15 min).

## Known gaps

- Google link/login has no UI in either client.
- No self-service account deletion, phone change or "log out everywhere" endpoint.
- A suspended user keeps a working access token (and open sockets) until the 15 min token expires; there is no per-request status check.
- Docs drift fixed while writing this pack: older notes called the cookie `rcab_refresh` with `SameSite=Strict`; the code uses `refresh_token` and `SameSite=Lax`. Corrected in `docs/ARCHITECTURE.md` section 8, `RUN-GUIDE.md`, `demo-walkthrough.md` and `technical-guide.md`. The published runbook artifact `docs/artifacts/rcab-demo-runbook.html` still says `rcab_refresh` until it is republished.
