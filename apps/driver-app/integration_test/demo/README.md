# Driver-app demo recording harness (RCAB-E8.S14)

Records the driver-app onboarding videos D01–D08 (`docs/onboarding/videos/driver/`, see its
[INDEX.md](../../../../docs/onboarding/videos/driver/INDEX.md)) from the **real app** running on an
Android emulator against the **dev** compose stack. Use it to re-record after a UI change, or as a
template for an on-device end-to-end scenario.

**Test harness only.** Nothing here ships: `lib/` has no demo code path, and the API has no demo
endpoint, flag or bypass. The app runs its normal code against the normal API with an ordinary
session (see [Sessions](#sessions)).

## Run it

```bash
pnpm dev:up                                  # dev stack, migrated (api :3000, OSRM in the compose net)
scripts/demo/record-driver.sh                # all scenes D01..D08 (≈ 2 min build + scene each)
scripts/demo/record-driver.sh D04 D06        # just these
KEEP_EMULATOR=1 scripts/demo/record-driver.sh D07   # leave the emulator running afterwards
```

Needs Flutter, the Android SDK with an AVD (default `Small_Phone`, override `AVD=…`), ffmpeg,
Node ≥ 20, and `android/app/google-services.json` (the app calls `Firebase.initializeApp()` at
start-up exactly as `lib/main.dart` does; see `../../README.md`). The script boots the AVD headless
if no emulator is attached and shuts it down at the end unless `KEEP_EMULATOR=1`.

Other knobs: `SERIAL` (default `emulator-5554`), `DEMO_CUE_PORT` (8787), `RAW_DIR` (raw webm + logs,
default `$TMPDIR/rcab-driver-demo`), `FFMPEG`. Per scene the raw recording and the
`<ID>.flutter.log` / `<ID>.director.log` stay in `RAW_DIR`; read those first when a scene fails.

## How it works

Three cooperating pieces per scene:

| Piece | Where it runs | Job |
|---|---|---|
| `host/session.mjs --scene Dnn` | host | Upserts the Area-B fixture users, resets them to a clean offline, trip-free state (`fixtures.mjs resetScene`), and prints an ordinary session for the scene's driver as `DEMO_JWT=… DEMO_REFRESH=…`. |
| `host/director.mjs` | host, HTTP on `127.0.0.1:8787` | The "cue" server the scene calls at `http://10.0.2.2:8787/cue/<name>`. Owns everything outside the app: the screen recorder, the emulator GPS (`adb emu geo fix`, moved along real OSRM routes), runtime permissions / the system permission dialog, simulated passengers (ordinary client sessions calling the public REST API) and, for D05, a simulated rival driver over the public Socket.IO protocol. |
| `dNN_*_test.dart` + `support/` | emulator | The scene: an `integration_test` that seeds the session, pumps the real `DriverApp` (same provider overrides as `lib/main.dart`) inside `DemoChrome`, and drives it with real taps. `support/harness.dart` (`Demo`) has the helpers (`boot`, `say`, `tap`, `type`, `waitFor`, `cue`, `end`); `support/demo_chrome.dart` draws the title card, the caption strip (scene id + the transition being shown) and a touch indicator. The app is laid out below the caption strip, so captions never hide UI. |

`scripts/demo/record-driver.sh` glues them together: session → director → `flutter test
integration_test/demo/<file> -d emulator-5554 --dart-define=DEMO_JWT=… --dart-define=DEMO_REFRESH=…
--dart-define=DEMO_CUE_BASE=http://10.0.2.2:8787` → ffmpeg (webm → H.264 MP4, 540×960, 24 fps,
CRF 28, faststart) into `docs/onboarding/videos/driver/<ID>-<slug>.mp4`.

The app reaches the host API at its default `API_BASE_URL`, `http://10.0.2.2:3000` (the emulator's
alias for the host loopback, `lib/di/providers.dart`).

### Recorder

`adb shell screenrecord` cannot encode on a headless swiftshader emulator (`Encoder failed
(err=-38)`), so the director uses the emulator console's own recorder (`adb emu screenrecord start
--time-limit 180 <host path>`), which writes VP9 `.webm` straight to the host. Hard cap: 180 s per
scene.

## Sessions

Both apps sign in with Google only until launch (RCAB-E8.S15; phone OTP is switched off by policy), which a
recording cannot complete (Google's account picker and consent). D01 records the sign-in screen as UI only
(the Continue with Google button is drawn from the live `GET /v1/auth/config`, never pressed). Every other
scene starts signed in:

1. `host/fixtures.mjs` mints an access token with the same claims as `AuthService.signAccessToken`,
   signed with the dev stack's own `JWT_SECRET` from `.env.dev`, and inserts the SHA-256 digest of a
   random refresh token into `auth_refresh_token`, exactly as the API stores one after a sign-in
   exchange. Refresh, possession-based logout (D08) and revocation behave normally.
2. The scene writes both tokens through the app's own `TokenStore` (flutter_secure_storage) before
   the app starts; `AuthNotifier` then restores the session as on any cold start.

Guards (mirroring `infra/load/prepare-dev.mjs`): refuses a non-loopback `API_BASE`,
`NODE_ENV=production` (process or env file), and a compose project that is not a `dev`/`test` one.
Fixture rows are tagged `firebase_uid LIKE 'demo-drv-%'` with ids `…7000NN / …7100NN / …7200NN`
(disjoint from `seed-dev.sh` and the load-test fixtures).

## Area B

Fixture drivers and passengers live around **(26.19, 91.82), Narengi, Guwahati**. That is ~9.8 km from
the web harness's Area A (26.1445, 91.7362), more than 2 × `dispatch.r2Meters` (4 km, see
`docs/POLICY.md`), so the two harnesses can record at the same time without offering each other's
rides. Pickup (26.1872, 91.8161) is ~0.5 km (straight line) from the driver start, inside `dispatch.r1Meters`.

## Shortcuts that differ from production timing

| Scene | Shortcut | Why it is faithful |
|---|---|---|
| D03 | The director revokes location permission before the app starts, then taps "Allow" in the real system dialog. | Same runtime-permission flow a new install sees. |
| D05 | The "lost" rival is a second fixture driver driven by the director over Socket.IO (`driver:location`, `ride_offer_response`). | Same public protocol the app uses; dispatch treats it as any driver. |
| D06 | Three simulated passengers book shared seats on one corridor, so the pool fills (`matching.maxSeats` 3 → `closed_full`) and dispatches at once instead of after `matching.poolTimeoutMs` (60 s). | Real matching, pricing and dispatch. |
| D07 | No-show: the director back-dates the ride's `arrived_at` by 305 s in the dev DB (`cue backdate-arrival`), then the scene re-reads the ride, which is what the screen's own timer does when `rides.noShowWaitMs` (5 min) elapses. | The server still re-validates the wait against `arrived_at`; nothing in the app or API is overridden. |

## Adding a scene

1. Copy a scene file (D04 is the canonical one), give it `Demo('Dnn')` and a `DemoTitle`.
2. If it needs something outside the app (a passenger action, GPS, DB inspection), add a cue to
   `host/director.mjs`. Keep cues to public API calls, adb, or read-only DB queries; the only
   DB writes are fixture setup/reset and the D07 back-date.
3. Add the id → `<file> <slug>` line to `scene_info` in `scripts/demo/record-driver.sh`.
4. Record, inspect the MP4 (e.g. a contact sheet:
   `ffmpeg -i X.mp4 -vf "fps=1/5,scale=240:-2,tile=6x2" -frames:v 1 sheet.png`), add the row to the
   video INDEX.

## Troubleshooting

- **Scene times out waiting for an offer:** check the director log; the passenger cue prints the
  API answer. A driver left online by a crashed run is cleaned by the next `session.mjs` (resetScene),
  so just re-run. Make sure `./scripts/seed-dev.sh --keepalive` drivers are not parked in Area B.
- **API restarted mid-scene:** the dev api hot-reloads on any source edit (tsx watch). The director
  retries refused connections for ~15 s with the same idempotency key.
- **`Firebase.initializeApp` fails:** `android/app/google-services.json` is missing (gitignored).
- **Emulator is slow on first boot:** the script waits for `sys.boot_completed`; the first
  `flutter test` build of the APK takes 1–2 minutes.
