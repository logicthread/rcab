# Auth and sessions

Phone-OTP identity (Firebase) exchanged for first-party JWTs, with single-use refresh-token rotation. Two session contracts share one service: a **web** contract (HttpOnly cookie + CSRF check) and a **native** contract (JSON tokens in secure storage) used by the driver app.

Back to [README](../README.md) · system context in [01-system-overview](../01-system-overview.md) · session state diagram in [state-machines](../state-machines.md).

## What it does

1. The client proves phone ownership to **Firebase** (SMS code) and gets a Firebase ID token.
2. The API verifies the ID token with `firebase-admin`, upserts the user and mints an **access JWT** (15 min) plus an opaque **refresh token** (30 days).
3. The access token goes in `Authorization: Bearer` on every REST call and in the Socket.IO handshake. The refresh token is rotated on every use.
4. Logout revokes the refresh token. Replaying an old refresh token revokes the whole session family.

A Google account can be linked to an existing phone account and later used to log in (`google/link`, `google/login`). Nothing in the shipped clients calls these two routes; they are API-only.

## User-visible behaviour

| Surface | Behaviour |
|---|---|
| Web `/signin` | Two steps: phone number in E.164 (`+91XXXXXXXXXX`) then 6-digit code. An invisible reCAPTCHA protects the send. On success the user lands on `/book`. Errors appear in a `role="alert"` line. Already signed in: redirected to `/book`. Videos W02, W01 |
| Web reload | The access token lives **in memory only** (Zustand). On reload `withAuth` calls `POST /v1/auth/refresh` with the cookie; no cookie or a rejected refresh sends the user to `/signin`. Video W09 |
| Web sign out | Local state is cleared first, then the server revokes the refresh token and clears the cookie. A refresh is done first if the access token is expired, because logout itself needs a valid bearer. Video W10 |
| Driver app sign-in | Phone + SMS code screen (`lib/features/auth/sign_in_screen.dart`). Tokens go to `flutter_secure_storage`. A rejected refresh signs the driver out. Video D01 |

Scene IDs: web [W01, W02, W09, W10](../videos/web/INDEX.md), driver app [D01](../videos/driver-app/INDEX.md).

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

Error codes: `invalid_firebase_token`, `invalid_refresh_token`, `account_disabled` (403 on exchange, 401 on refresh), `csrf_rejected` (403), `unauthorized`, `google_already_linked`, `not_found`. The envelope is always `{ "error": { "code", "message", "request_id" } }`.

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

- Without SMS (dev, demos): add **test phone numbers** with fixed codes in the Firebase console, or use a pre-minted `FIREBASE_PHONE_TEST_TOKEN` for curl-only checks ([RUN-GUIDE](../../manual-testing/RUN-GUIDE.md) section 3). Seeded fixture users have synthetic `firebase_uid`s and cannot sign in.
- Suspend a user: `UPDATE app_user SET status = 'suspended' WHERE id = ...`. Their next refresh fails and revokes their tokens; an access token already issued stays valid until it expires (at most 15 min).

## Known gaps

- Google link/login has no UI in either client.
- No self-service account deletion, phone change or "log out everywhere" endpoint.
- A suspended user keeps a working access token (and open sockets) until the 15 min token expires; there is no per-request status check.
- Docs drift fixed while writing this pack: older notes called the cookie `rcab_refresh` with `SameSite=Strict`; the code uses `refresh_token` and `SameSite=Lax`. Corrected in `docs/ARCHITECTURE.md` section 8, `RUN-GUIDE.md`, `demo-walkthrough.md` and `technical-guide.md`. The published runbook artifact `docs/artifacts/rcab-demo-runbook.html` still says `rcab_refresh` until it is republished.
