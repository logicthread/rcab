# Onboarding guide: UI/UX developer

You own what a human sees and touches: the passenger web app (`apps/web`, Next.js 14) and the
driver app (`apps/driver-app`, Flutter). You do not own business rules (fares, timers, who
wins an offer). Those live on the server and reach your screens as API responses and socket
events. Your job is to render server truth faithfully, survive reconnects, and keep the copy
and states understandable.

Back to the [onboarding index](../README.md). Facts here were checked against the code on
branch `onboarding/walkthrough`; where a vault note disagrees with the code, the code wins.

---

## 1. Day-1 / week-1 checklist

### Day 1: get it running

1. Read [`CLAUDE.md`](../../../CLAUDE.md) (session contract, ports, commands) and skim
   [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) sections 2 to 4 (topology, routes, sockets).
2. Prerequisites: Docker Desktop, Node 20+, pnpm 10 (`corepack` or a global install; in some tool
   shells `pnpm` is not on `PATH`, add your Node manager's bin dir), Flutter 3.22+ with the Android SDK
   for the driver app.
3. Bring the stack up and prove it is healthy:

   ```bash
   pnpm install
   pnpm dev:up          # builds + starts everything, incl. observability; auto-creates .env.dev
   pnpm dev:smoke       # waits for api / -> 200 (postgres + redis connected)
   ```

4. Apply migrations on a fresh database (they are NOT applied on container restart):

   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts
   ```

5. Open the web app at http://localhost:3002 (container listens on 3000, mapped to 3002). The api is
   http://localhost:3000, Grafana http://localhost:3001 (admin/admin). Web code is bind-mounted,
   so edits hot-reload without a rebuild.
6. Watch the videos for the screens you will touch (section 4) before clicking around blind.

### Week 1: first build, first test, first change

| Step | Command | Expected |
|---|---|---|
| Web unit tests | `pnpm --filter @rcab/web test` | vitest + jsdom, all green |
| Web lint | `pnpm --filter @rcab/web lint` | `next lint` clean |
| Web e2e | `pnpm --filter @rcab/web test:e2e` | needs the dev stack up; currently one spec (`apps/web/e2e/signin.e2e.spec.ts`) |
| Driver unit and widget tests | `cd apps/driver-app && flutter pub get && flutter test` | all green (or use the `/flutter-test` skill) |
| Driver static analysis | `cd apps/driver-app && flutter analyze` | no issues |
| Policy doc drift | `pnpm policy:doc:check` | passes (fails if you changed a client policy knob without regenerating) |
| Gate before a story closes | `pnpm verify` | lint + policy drift + api coverage + integration (needs Docker) |

First small change (suggested): change one banner string in
`apps/web/src/app/book/ride-tracking-panel.tsx` (the `BANNER` map), run
`pnpm --filter @rcab/web test`, fix the assertion in `ride-tracking-panel.test.tsx`, and watch the new
copy appear in the browser. Then do the same for a string in
`apps/driver-app/lib/features/ride/ride_screen.dart` and its widget test.

Signing in needs a real Firebase phone OTP. For testing without SMS, add test phone numbers with fixed
codes in the Firebase console (Authentication, Sign-in method, Phone, Test numbers). Seeded fixture
users (`./scripts/seed-dev.sh`) have synthetic Firebase UIDs and cannot sign in; they only exist so
dispatch has candidates. See [`RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md) section 0.

---

## 2. What you own and the mental model

```
 Firebase phone OTP  ->  POST /v1/auth/firebase-exchange  ->  access JWT (memory) + refresh cookie
 REST (quote, create, cancel, rate)  +  Socket.IO (snapshots, state, location, pool updates)
```

Mental model, in four sentences:

1. **The server is the authority.** Postgres rows decide the ride and pool state. The client never
   invents a status; it displays the last one the server told it.
2. **Realtime is subscribe-then-snapshot.** After a REST create, the client emits `ride:subscribe` or
   `pool:subscribe`; the server acks and sends a full snapshot, then incremental events.
3. **Every event carries an ordering version** (pool: `shared_rides.state_version`; ride: a forward-only
   status rank). The client applies a snapshot if it is at least as new, an event only if strictly
   newer, and drops anything for a different ride. This is the "version gate".
4. **Reload must restore.** Both clients rebuild from a snapshot after reload or reconnect. A UI that
   only works for the happy path in one uninterrupted session is a bug (video W09 shows the web case).

### Web app (`apps/web`)

Next.js 14 App Router, React 18, Zustand 5, react-leaflet 4 / Leaflet 1.9, socket.io-client 4,
Firebase JS SDK 12 (phone auth only).

| Route | File | State today |
|---|---|---|
| `/` | `src/app/page.tsx` | Placeholder: prints "rcab, Phase 0 scaffold" and a stack status. There is no real landing page. |
| `/signin` | `src/app/signin/sign-in-client.tsx` | Two-step form: phone (E.164), then 6-digit OTP. Invisible reCAPTCHA. |
| `/book` | `src/app/book/book-client.tsx` (655 lines) | The whole product: ride type toggle, pickup/drop pickers, quote, request, tracking, rating. Map is client-only (`dynamic(..., { ssr: false })`). |

Code map (all under `apps/web/src`):

| Concern | Files |
|---|---|
| Auth state and refresh | `lib/auth/store.ts` (Zustand), `lib/auth/with-auth.tsx` (route guard), `lib/auth/firebase.ts` |
| Booking state machine (client side) | `lib/booking/store.ts` (stages `idle, quoting, quoted, requesting, opened, slotted, solo_fallback, tracking, error`) |
| REST client | `lib/booking/api.ts` (quote, create with `Idempotency-Key`, cancel, rate) |
| Socket client and version gates | `lib/booking/ws.ts` (`createVersionGate`, `rideStatusVersion`, subscribe retry with backoff) |
| Wire types | `lib/booking/types.ts` (mirrors server payloads) |
| Address lookup | `lib/geo/nominatim.ts`, `app/book/address-search.tsx` (debounced, min 3 chars) |
| Map | `app/book/map-picker.tsx` (inline-SVG pins to avoid Leaflet icon bundler issues) |
| Status surfaces | `app/book/ride-tracking-panel.tsx` (status banner, cancel, rating), `pool-badge.tsx`, `solo-fallback-banner.tsx`, `ride-type-toggle.tsx` |
| Client policy knobs | `config/policy.ts` (`WEB_POLICY` and `WEB_POLICY_META`) |

Client policy (`apps/web/src/config/policy.ts`) holds every client-side timing: token refresh margin
(30 s), idempotency-in-progress replay (1 s), subscribe attempts (5) and backoff (1/2/4/8 s), socket
reconnect ceiling (5 s), address debounce (400 ms) and minimum query (3 chars). Values marked
`server-mirror` copy a server rule the client cannot read at runtime. The file must stay
dependency-free because `scripts/policy-doc.ts` imports it; add a `WEB_POLICY_META` entry for every new
knob or `pnpm policy:doc` fails.

Auth detail worth knowing: the access JWT lives only in memory (Zustand), never in `localStorage`.
The refresh token is an HttpOnly cookie (`rcab_refresh`) rotated single-use by
`POST /v1/auth/refresh`. `refreshAccessToken` is single-flight; `signOut` bumps `sessionGen` so a
refresh already in flight cannot resurrect the old session (video W10).

### Driver app (`apps/driver-app`)

Flutter (SDK 3.3+), Riverpod 2, go_router 14, Dio, socket_io_client, Firebase Auth, a foreground
service for location. Android is the only supported target (Phase-0). Feature-first layout:

| Area | Path | Notes |
|---|---|---|
| Routing and auth redirect | `lib/routing/app_router.dart` | `/sign-in`, `/home`, `/offer/:id`, `/ride/:id`, `/shared-ride/:id`, `/rating/:id`, `/earnings`, `/profile`, `/profile/vehicle/add`. Unauthenticated users are redirected to `/sign-in`. |
| DI (providers) | `lib/di/providers.dart` | `API_BASE_URL` is a `--dart-define` (default `http://10.0.2.2:3000`, the emulator's host alias). |
| Auth, tokens | `lib/core/auth/*` | Native exchange (JSON tokens, no cookie, no CSRF) via `/v1/auth/native/*`; `token_store.dart` uses secure storage. |
| API client | `lib/core/api/api_client.dart` | Dio with `JwtRefreshInterceptor` (single refresh shared by waiting requests; transient failures keep the session). |
| Realtime | `lib/core/realtime/*` | `realtime_socket.dart`, `offer_outcome.dart`, `driver_assignment.dart`, `location_bridge.dart`. |
| Online/offline and location | `lib/core/driver/*`, `lib/core/location/foreground_service.dart` | OEM-kill banner and onboarding sheet under `features/home/`. |
| Screens | `lib/features/{auth,home,offer,ride,shared_ride,rating,earnings,profile}` | Each feature has screen, provider/controller, models. |
| Client policy knobs | `lib/core/config/policy.dart` (`DriverPolicy`) | Each `static const` needs a doc line plus a `unit: ... | source: ... | decision: ...` line or the policy doc generator fails. |

Known stubs, so you do not look for code that is not there:
`features/earnings/earnings_screen.dart` renders "Earnings, coming in E7"; `lib/core/fcm/` is an empty
directory (push notifications are not implemented, although the `firebase_messaging` dependency is
declared); `apps/driver-app/integration_test/` is empty (no Flutter integration tests yet).
The driver app does not embed a map: "Navigate" hands off to Google Maps with a
`google.navigation:` intent from `ride_screen.dart`.

---

## 3. Key workflows for this role

The workflow write-ups live in [`../workflows/`](../workflows/README.md) and per-area behaviour in
[`../functionality/`](../functionality/). The state diagrams you must keep in sync with the UI are in
[`../state-machines.md`](../state-machines.md). Most useful for this role:
[local setup](../workflows/local-setup.md), [testing](../workflows/testing.md),
[adding a feature end to end](../workflows/adding-a-feature-end-to-end.md),
[debugging and tooling](../workflows/debugging-and-tooling.md), and the functionality pages
[auth and sessions](../functionality/auth-and-sessions.md), [normal booking](../functionality/normal-booking.md),
[quoting and pricing](../functionality/quoting-and-pricing.md),
[driver onboarding and presence](../functionality/driver-onboarding-and-presence.md) and
[realtime protocol](../functionality/realtime-protocol.md). Read these first:

| You are changing... | Read | Watch |
|---|---|---|
| Booking form, quote, request, ride tracking | workflows for normal and shared booking in [`../workflows/`](../workflows/), plus the web functionality file in [`../functionality/`](../functionality/) | W03 normal ride, W07 shared ride |
| Cancel and no-show UI | the cancellation workflow, ride state machine in [`../state-machines.md`](../state-machines.md) | W04, W05, W06 (web); D07 (driver) |
| Scheduled bookings and the "searching" banner | scheduled workflow, `docs/POLICY.md` "Scheduled booking" | W08 |
| Reload and reconnect behaviour | realtime section of [`../functionality/`](../functionality/), `lib/booking/ws.ts` | W09 |
| Sign-in, session, sign-out | auth workflow | W02, W10 (web); D01 (driver) |
| Driver offer, accept, ride screens | driver workflows | D03 to D07 |
| Anything with a time or retry value | [`docs/POLICY.md`](../../POLICY.md) "Client knobs" | n/a |

Videos (scene IDs; every area has an `INDEX.md` with the file names and what each shows):

- Passenger web: [`../videos/web/INDEX.md`](../videos/web/INDEX.md), scenes W01 to W10.
- Driver app: [`../videos/driver/INDEX.md`](../videos/driver/INDEX.md), scenes D01 to D08.
- Ops (for context on what the team sees when you break something): [`../videos/ops/INDEX.md`](../videos/ops/INDEX.md), M01 to M06.

### Re-recording the demo videos

The story that produced the videos (RCAB-E8.S14) ships harnesses so they can be regenerated after a UI
change. Entry points: `pnpm demo:record:web` (Playwright, passenger web), `scripts/demo/record-driver.sh`
(driver app on an emulator), `pnpm demo:record:ops` (Grafana, Prometheus, Loki, Kuma, terminal). Check the
`INDEX.md` of each area for the exact prerequisites, because they depend on the dev stack being up and on
the demo-session setup (sessions are minted by a test-harness-only helper; there is no auth backdoor in
shipped code, and you must not add one). If you change copy or layout on a recorded path, re-record that
scene and commit the new file with the change.

---

## 4. Conventions and gotchas

### Rendering server truth

- **Statuses are a closed vocabulary.** Ride status is one of `requested, dispatching, accepted,
  en_route, arrived, in_progress, completed, cancelled, no_driver, no_show`. The web store maps unknown
  strings to `requested` (`normalizeStatus`) instead of printing raw text. Keep both clients in sync with
  `apps/api/src/modules/realtime/realtime.protocol.ts` (the rank table in `ws.ts` is a copy).
- **Terminal statuses** are `completed, cancelled, no_driver, no_show`. After one of them the UI offers a
  new booking, not further transitions.
- **`dispatching` and `requested` both mean "still searching"** (`isSearching` in `lib/booking/store.ts`).
  For a scheduled ride the server may re-arm the search; the snapshot or `ride_dispatch_retry` carries an
  optional `retryUntil`, and the banner only shows a time when the server sent a valid one (RCAB-E8.S13).
- **Server-owned numbers are never hardcoded.** Fares come from the quote and create responses
  (`Money` is `{ amount in paise, currency: 'INR' }`). The offer countdown uses the offer's `ttlMs`; the
  Dart `offerTtlFallbackMs` (12 s) is only a fallback for a payload without it.
- **Shared-ride fare is fixed at join** (`agreedFare` in the booking store). Do not recompute it on the
  client. Whether it should be readjusted is an open product decision (RCAB-E8.S9).
- Cancel is hidden once a trip is `in_progress`: the server rejects a client cancel then. The driver
  no-show button unlocks only after the arrival wait (`DriverPolicy.noShowWait`, 5 min) and the server
  re-validates.

### Idempotency and races

- `POST /v1/rides` carries an `Idempotency-Key`. The API answers `409 idempotency_request_in_progress`
  while the first attempt is still running and `422 idempotency_key_conflict` if the same key is reused
  with a different body. The web client replays once after
  `WEB_POLICY.booking.idempotencyInProgressRetryMs`. Do not add blind retry loops.
- A quote is a signed token with an expiry. If it expired by submit time, `invalidateQuote()` bumps
  `quoteEpoch` to force a fresh quote even when the coordinates did not change.
- The subscribe ack can be `unavailable` (server could not authorize or read yet); retry with the policy
  backoff rather than showing an error immediately.

### Maps and addresses

- OSM tiles and Nominatim are used for booking (ADR-0004); Google Maps is used only for driver
  navigation hand-off. Nominatim has a fair-use policy: keep the debounce and minimum query length.
- The dev OSRM graph covers **north-east India (Guwahati, about 26.14, 91.73)**. Pickup and drop outside
  that region get no route and the quote fails. The presets in the booking screen are inside it.
- Leaflet touches `window`; any component that imports it must be loaded with `ssr: false`.

### Styling, design system and copy

- There is **no design system and no shared stylesheet**. Components use inline `style={{...}}` objects
  (36 in `book-client.tsx` alone). `tailwind.config.ts` exists and `tailwindcss` is a dependency, but
  there is no `@tailwind` CSS entry and no PostCSS config, so Tailwind classes currently do nothing.
  Decide deliberately (adopt Tailwind properly or drop it) before building new screens.
- The driver app uses stock Material widgets; there is no custom theme file.
- UX copy is plain and short, written in the component that uses it (e.g. `BANNER` in
  `ride-tracking-panel.tsx`; dialog titles in `ride_screen.dart`). There is no copy catalogue or
  localisation layer. Target users are in tier-2/3 Indian cities on mid-range Android, so keep strings
  short and plan for translation before adding more.
- Performance budgets (vault `90-quality/performance-budget.md`): `/book` TTI <= 4 s on throttled 3G, initial
  JS <= 200 KB gz, map mount <= 1 s; driver app cold start to `/home` <= 3 s, offer screen render <= 200 ms
  after the socket event. They are budgets, not enforced checks.

### Accessibility status (honest)

Not audited. The web app has a handful of ARIA attributes and labels (17 `aria-`/`role`/`htmlFor` uses in
non-test code; the sign-in inputs are labelled and the star rating buttons have `aria-label`), but no
focus management, no live region for the status banner, no contrast review, and maps are not keyboard
operable. The driver app has essentially no `Semantics` or tooltips (2 occurrences). Treat any new screen
as needing WCAG 2.1 AA checks (the `design:accessibility-review` skill helps) and plan an audit as a
real task (see section 7).

### Test conventions

- Web unit tests sit next to the file (`*.test.ts(x)`), vitest with jsdom and Testing Library; selectors
  use `data-testid` (27 in the booking UI). Add a test id before writing an e2e that depends on text.
- Driver tests mirror `lib/` under `test/` (`test/features/...`, `test/core/...`) with `mocktail` and
  `test/support/fake_realtime_socket.dart` for socket behaviour.
- The e2e suite uses the running dev stack (`E2E_BASE_URL`, default http://localhost:3002), does not start
  its own server, and has one spec today. A Firebase OTP round trip is not automated.
- Hot-reload gotcha: `NEXT_PUBLIC_*` values are inlined at build time. In the dev stack change them in
  `.env.dev` and restart the web service; in the release images they are Docker build args and changing
  them means a new image.

---

## 5. Quality gates

| Gate | Command | Notes |
|---|---|---|
| Lint (whole workspace) | `pnpm lint` | `next lint` for web, ESLint for api and packages |
| Types | `pnpm -r exec tsc --noEmit` | what Jenkins runs after building `@rcab/shared` and `@rcab/api-client` |
| Web unit | `pnpm --filter @rcab/web test` | in Jenkins "Unit tests" |
| Driver | `flutter analyze && flutter test` in `apps/driver-app` | not run by Jenkins; you must run it yourself (see section 7) |
| Policy drift | `pnpm policy:doc:check` | regenerate with `pnpm policy:doc` after editing `WEB_POLICY` or `DriverPolicy` |
| Story gate | `pnpm verify` | required before `/close-story` or `/ship-story`. `RCAB_SKIP_INT=1` skips containers but never counts as green. |
| Manual | walk the affected scene in a browser and the matching video | reload mid-flow once (W09) |

Commit shape: `<type>(<scope>): <subject>` with `scope` `web` or `driver-app`, and a mandatory
`Story: RCAB-Ex.Sy` trailer on any commit that touches code (a hook blocks it otherwise). See
[`95-delivery/commit-story-linkage.md`](../../../95-delivery/commit-story-linkage.md).

---

## 6. Escalate (HITL) before you act

From [`95-delivery/hitl-touchpoints.md`](../../../95-delivery/hitl-touchpoints.md), the ones that bite UI work:

- A story's acceptance criteria change mid-flight (for example a design that needs a new server field).
- Adding a vendor or paid service (map tiles with a key, analytics, crash reporting, a push provider).
- Anything touching secrets handling or Firebase configuration.
- Walking a demo for sign-off.
- Bumping a demo's headline or splitting an epic.
- A flaky e2e that you want to quarantine instead of fix.
- Business-rule questions (cancel fee, shared-fare readjustment, who pays after a no-show): these are
  owner decisions, not UI decisions. Ask; do not encode a guess in the client.

If you need a new field, event or status from the server, that is a backend change plus a contract
change: raise it with the backend owner and update `lib/booking/types.ts` and the Dart models together.

---

## 7. First 5 good tasks (from real open gaps)

1. **Replace the placeholder landing page (`/`).** `src/app/page.tsx` still says "Phase 0 scaffold".
   Build a real entry that routes to `/signin` or `/book` by auth state. Small, visible, covered by W01.
2. **Decide on and fix the styling foundation.** Either wire Tailwind properly (CSS entry, PostCSS config)
   or remove it, then move the repeated inline styles of `book-client.tsx` into shared components.
   Splitting that 655-line component is a natural follow-up.
3. **Accessibility pass on `/signin` and `/book`.** Add a live region to the tracking banner, keyboard
   access for the map alternatives (address search already exists), focus management on step changes,
   contrast fixes; add a Playwright check with axe or at least role-based selectors.
4. **Driver earnings screen (RCAB-E7.S4, status draft).** `EarningsScreen` is a stub. This needs the
   E7 backend aggregation first (E7.S2 is draft), so start by writing the screen against a fixture and
   agreeing the response shape with the backend owner. Needs `/gen-story` before pickup.
5. **Add driver-app coverage that CI does not give you.** `apps/driver-app/integration_test/` is empty and
   Jenkins does not run `flutter test`. Add a Flutter `integration_test` for sign-in to online toggle, and
   propose the CI stage (this touches CI, so involve the DevOps owner).

Also worth picking up: a web history page (RCAB-E7.S3) and the rating moderation view with the cold-start "New" display (RCAB-E7.S1),
once their stories are generated.

---

## 8. References

| Topic | Where |
|---|---|
| Orientation | [`CLAUDE.md`](../../../CLAUDE.md), [`00-index/HOME.md`](../../../00-index/HOME.md), [`00-index/reading-paths.md`](../../../00-index/reading-paths.md) (use the "Frontend implementation" paths, load only what they list) |
| Architecture, routes, sockets | [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| All tunable numbers | [`docs/POLICY.md`](../../POLICY.md) (generated; never edit by hand) |
| Bring-up and hand-walking demos | [`docs/manual-testing/RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md) |
| Web structure and state notes | [`50-clients/web-nextjs-structure.md`](../../../50-clients/web-nextjs-structure.md), [`web-state-management.md`](../../../50-clients/web-state-management.md), [`web-pages-routes.md`](../../../50-clients/web-pages-routes.md), [`web-osm-integration.md`](../../../50-clients/web-osm-integration.md) |
| Driver structure and screens | [`50-clients/driver-flutter-structure.md`](../../../50-clients/driver-flutter-structure.md), [`driver-screens.md`](../../../50-clients/driver-screens.md), [`driver-state-management.md`](../../../50-clients/driver-state-management.md), [`driver-background-location.md`](../../../50-clients/driver-background-location.md) |
| Realtime events | [`40-backend/websocket-events.md`](../../../40-backend/websocket-events.md) |
| Journeys and personas | [`10-product/`](../../../10-product/) (`journey-client-book-normal`, `journey-driver-accept-ride`, ...) |
| Driver app setup | [`apps/driver-app/SETUP.md`](../../../apps/driver-app/SETUP.md) |
| Playwright skill | `.claude/skills/playwright-run/SKILL.md` (`/playwright-run [spec] [--headed] [--video]`) |
| Flutter skill | `.claude/skills/flutter-test/SKILL.md` (`/flutter-test [unit|widget|integration|all]`) |
| Delivery rules | [`95-delivery/demo-cadence.md`](../../../95-delivery/demo-cadence.md), [`hitl-touchpoints.md`](../../../95-delivery/hitl-touchpoints.md), [`stories-index.md`](../../../95-delivery/stories-index.md) |
