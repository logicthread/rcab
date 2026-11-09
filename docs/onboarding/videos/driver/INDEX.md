# Driver app videos (D01-D08)

Recorded by `scripts/demo/record-driver.sh` from the **real Flutter driver app** (`apps/driver-app`, debug build) on an
Android emulator (AVD `Small_Phone`, headless) against the **dev** compose stack. Harness and how it works:
[apps/driver-app/integration_test/demo/README.md](../../../../apps/driver-app/integration_test/demo/README.md). Do not edit the
videos by hand: re-record (`scripts/demo/record-driver.sh D04`, or no argument for all eight).

Each video opens with a title card listing the transitions it covers; an orange-tagged caption strip above the app names the
current step (the app is laid out *below* the strip, so it never hides UI); an orange ring marks each tap. Phone portrait,
540x960, H.264, no audio.

How to read them: the driver app and the API are the real code from this checkout, with no demo code path. Everything outside the phone is a **host-side
director** (`integration_test/demo/host/director.mjs`): simulated passengers calling the public REST API with ordinary client
sessions, the emulator GPS moved along real OSRM routes, and (D05) a simulated rival driver on the public Socket.IO protocol.
The passenger side of the same flows, with the real web UI, is in the [web videos](../web/INDEX.md).
Sessions are minted by the harness for fixture users (never by the app or the API; see the harness README, "Sessions").
All driver scenes run in "Area B" (Narengi, Guwahati, around 26.19, 91.82), more than 2 x `dispatch.r2Meters` from the
web harness's Area A, so both harnesses can record at once.

Related reading: [docs/onboarding/state-machines.md](../../state-machines.md) (ride, offer, pool and presence state machines),
[docs/POLICY.md](../../../POLICY.md) (dispatch, matching, rides, drivers knobs; "Driver app" client knobs),
[docs/ARCHITECTURE.md](../../../ARCHITECTURE.md), [ops videos](../ops/INDEX.md), [web videos](../web/INDEX.md).

## Videos

| ID | Video | Length | Size | What it shows | States / transitions |
|---|---|---|---|---|---|
| <a id="d01"></a>D01 | [Sign-in screen (phone OTP UI)](D01-sign-in.mp4) | 34 s | 0.2 MB | Cold start with no stored session lands on `/sign-in`; a local-format number is rejected (E.164 check), the corrected number clears the error. No OTP is requested. | No ride states. Auth: unauthenticated -> (Send OTP -> Firebase SMS -> 6-digit code -> `POST /v1/auth/native/firebase-exchange` -> tokens in secure storage) -> `/home` (narrated, not exercised). |
| <a id="d02"></a>D02 | [Vehicle onboarding](D02-vehicle-onboarding.mp4) | 62 s | 0.4 MB | A newly verified driver with no vehicle is refused going online; registers a vehicle (form validation, `POST /v1/vehicles`), selects it (`PATCH /v1/drivers/me/vehicle`) and goes online. | Driver: offline -> go online refused (`400 no_vehicle_selected`) -> vehicle registered -> current vehicle set -> online -> offline. |
| <a id="d03"></a>D03 | [Go online and presence](D03-go-online-presence.mp4) | 82 s | 0.3 MB | The Android location-permission dialog, the one-time OEM battery-whitelist sheet, going online, and what dispatch sees in Redis while the driver drives and while parked. | Driver: offline -> online (`POST /v1/drivers/online`; foreground service streams `driver:location`) -> moving (geo index follows) -> parked (20 s heartbeat keeps `last_seen` fresh under the 60 s sweep) -> offline (`POST /v1/drivers/offline`, removed from `active_drivers`). |
| <a id="d04"></a>D04 | [Solo ride: offer to rating](D04-solo-ride-lifecycle.mp4) | 68 s | 0.4 MB | A passenger nearby books a normal ride; the driver gets the offer with its 12 s countdown, accepts, drives to the pickup, starts and ends the trip, and rates the passenger. Captions show what the passenger's API reports at each step. | Offer: offered -> accepted. Ride: requested -> dispatching -> accepted -> en_route (server, on the first location packet) -> arrived -> in_progress -> completed, then rating (`POST /v1/rides/:id/ratings`). |
| <a id="d05"></a>D05 | [Offers that end without a trip](D05-offer-decline-expire-lost.mp4) | 46 s | 0.3 MB | Three offers in a row: the driver declines one, lets one expire, and loses one to a nearer rival driver who accepts first. Each ending is explained on the home screen. | Offer: offered -> declined; offered -> expired (`dispatch.offerTtlMs`, 12 s); offered -> lost (`ride_offer_outcome`, another driver accepted). The rides themselves stay requested/dispatching (re-offered) or go to the rival (accepted). |
| <a id="d06"></a>D06 | [Shared ride: pool to stops](D06-shared-ride-stops.mp4) | 59 s | 0.4 MB | Three passengers on one corridor fill a pool, which is offered to the driver as one trip with its itinerary (Accept / Decline); the driver confirms 3 pickups and 3 drop-offs in order; home shows a completion summary. | Pool: open -> open -> closed_full (3rd seat, `matching.maxSeats`) -> claimed (driver accepts; sets `claimed_by_driver_id`, pool_state stays closed_full) -> closed_started (first pickup) -> completed (last drop-off). Stops: pending -> confirmed (`stop:pickup_confirmed` / `stop:drop_confirmed`, then the server echo), x6. |
| <a id="d07"></a>D07 | [Driver cancel, passenger cancel, no-show](D07-driver-cancel-no-show.mp4) | 63 s | 0.5 MB | Three accepted rides that end without a trip: the driver cancels with a reason; the passenger cancels and it reaches the driver live; the passenger does not show and, after the wait, the driver reports a no-show. | Ride 1: accepted -> cancelled (cancelled_by=driver, reason). Ride 2: accepted -> en_route -> cancelled (cancelled_by=client, pushed by `ride_state_changed`). Ride 3: accepted -> en_route -> arrived -> no_show (after `rides.noShowWaitMs`, 5 min). |
| <a id="d08"></a>D08 | [Earnings, profile, sign out](D08-earnings-profile-sign-out.mp4) | 43 s | 0.3 MB | The earnings tab (placeholder), the profile with the driver's vehicles and current-vehicle selection, then sign-out, verified on the server. | Driver: online -> offline (sign-out goes offline first). Session: refresh token live -> revoked (`POST /v1/auth/native/logout`), secure storage cleared, router -> `/sign-in`. |

Total: 8 videos, 2.9 MB.

## Per-scene notes

- **D01**: UI only by design: the OTP step needs a real SMS. Every other scene starts from a harness-created session for a
  fixture driver (seeded into the app's own secure storage before start-up; harness README, "Sessions").
- **D02**: Uses the fixture "Demo Driver B3 (new)", whose vehicles are deleted before the scene. The server, not the app,
  owns the vehicle rule; the profile marks the vehicle "Selected" for this app session only, because there is no API that
  returns the driver's current vehicle (see "Known gaps").
- **D03**: The director revokes the location permission before the app starts so the real system dialog appears; it taps the dialog's allow button. Presence numbers in the captions are read live from Redis (`active_drivers` geo index,
  `driver:state:<id>.last_seen`) and Postgres (`driver.availability`).
- **D04**: The server moves the ride `accepted -> en_route` on the first location packet after accept; the app follows it live
  over `ride:subscribe`. "Navigate to pickup / dropoff" would open Google Maps (not opened in the recording).
- **D05**: The rival is a second fixture driver run by the director over Socket.IO, parked next to the pickup and accepting
  3.5 s after its offer. Both drivers are inside `dispatch.r1Meters`, so both get the wave-1 offer.
- **D06**: With three riders the pool fills and dispatches at once; with fewer it would close by timeout after
  `matching.poolTimeoutMs` (60 s) and dispatch then (web video W07 shows that path). Stops are shown as coordinates because
  there is no geocoding yet.
- **D07**: The 5-minute no-show wait is not sat through: the director back-dates the ride's `arrived_at` by 305 s in the dev
  database and the scene re-reads the ride, which is what the screen's own timer does when the wait elapses. The server still
  re-validates the wait against `arrived_at`. No env override, no API restart.
- **D08**: Earnings is a placeholder screen; there is no earnings API yet (Epic E7).

## Known gaps seen while recording (not fixed here)

- No earnings data or API (D08); the screen is a placeholder.
- No per-passenger rating after a shared ride (D06): a pool is not a `rides` row, so the solo rating endpoint cannot rate it.
  The app now returns home with a summary instead of opening a rating prompt that could never be submitted.
- No endpoint returns the driver's current vehicle, so after a restart the profile cannot mark which vehicle is current (D02, D08).
- Offers, the ride screen and shared stops show raw coordinates and the ride screen shows the ride UUID: there is no
  geocoding / place names yet (D04-D07).

## Fixed while recording (RCAB-E8.S14)

Root-cause fixes in the driver app, each with a regression test under `apps/driver-app/test/`:

- Going online never started the location foreground service (service missing from `AndroidManifest.xml`), so drivers were
  swept offline after 60 s; a parked driver also went silent (no heartbeat) and a background fix could hang forever.
- Go online did not request the location permission and, on any location error, went online at (0, 0).
- A cold start blocked every driver from going online (client-side vehicle pre-check on an id the app never loads).
- After one offline -> online cycle the driver never received another offer (the presence socket shared, then disposed,
  the realtime socket's listeners).
- The ride screen never heard passenger cancels or server-side transitions (no `ride:subscribe`); the no-show button never
  unlocked (no `arrivedAt` after the arrive transition).
- Declining an offer left the driver on a blank "Waiting for an offer" screen; offers that were lost, expired or revoked,
  and rides cancelled by the passenger, vanished without explanation (now a home-screen notice).
- The profile failed to load vehicles against the real API (snake_case vs camelCase JSON).
- API error bodies were read at the wrong level (`{error: {code, message}}` envelope), so `no_vehicle_selected` and
  `vehicle_reg_exists` were never recognised and drivers saw Dio's internal error text.
- A shared ride opened a rating prompt for the pool id that always failed (404).
- On a small phone the rating screen overflowed with the keyboard open and pushed Submit off-screen.
- Shared-ride stops and buttons printed passenger UUIDs (now "Passenger 1..3").
- Form errors (sign-in phone, vehicle form) stayed red after the field was corrected.
- There was no way to sign out; the earnings placeholder showed an internal tracker reference ("coming in E7").

## Regenerate

```bash
pnpm dev:up                                  # dev stack, migrated
scripts/demo/record-driver.sh                # all eight (about 25 min: an APK build per scene)
scripts/demo/record-driver.sh D06            # one scene
KEEP_EMULATOR=1 scripts/demo/record-driver.sh D02 D07
```

Raw recordings and per-scene logs land in `$TMPDIR/rcab-driver-demo` (`<ID>.flutter.log`, `<ID>.director.log`).
Encoding: emulator console recorder (VP9 webm) -> `ffmpeg -vf fps=24,scale=540:-2 -c:v libx264 -crf 28 -preset slow
-pix_fmt yuv420p -movflags +faststart`.
