# Driver onboarding and presence

How an account becomes a driver, how a driver registers a vehicle, goes online, stays visible to dispatch, and is taken offline. "Presence" means: being in the Redis geo index with a fresh `last_seen`.

Back to [README](../README.md) · see also [dispatch-and-offers](dispatch-and-offers.md), [realtime-protocol](../functionality/realtime-protocol.md) · diagrams in [state-machines](../state-machines.md) (driver availability).

## What it does

1. **Provisioning** (operator): an account is promoted to `role=driver` and gets a `driver` row. There is no API or screen for this in Phase-0.
2. **Vehicle registration** (driver app): the driver adds one or more vehicles and selects the current one.
3. **Go online**: the driver sends their position; the API writes the Redis geo index and presence hash, and flips `driver.availability` to `online`.
4. **Presence upkeep**: while online the app streams `driver:location` over the socket; each accepted packet refreshes the geo index and `last_seen`.
5. **Go offline / auto-offline**: an explicit toggle removes presence at once; silence for 60 s triggers the sweep, which forces the driver offline and tells the app (`force_offline`).

## Provisioning a driver (operator procedure)

`POST /v1/auth/firebase-exchange` always creates a **client**. A driver is made by promoting an existing account. Derived from the schema (`app_user`, `driver`); `driver.user_id` is the primary key and references `app_user.id`:

```sql
-- 1. the person signs in once on the driver app (creates app_user + client rows)
-- 2. promote
UPDATE app_user SET role = 'driver' WHERE phone_e164 = '+91XXXXXXXXXX';
INSERT INTO driver (user_id, verified_at)
  SELECT id, now() FROM app_user WHERE phone_e164 = '+91XXXXXXXXXX';
```

The role is read from the database on every token refresh, so the driver sees the new role after the next refresh or a fresh sign-in. The pilot runbook (manual driver verification, RCAB-E9.S1) is not written yet; `driver.verified_at` and `license_no` exist but **no code reads them**, so verification is currently a convention, not an enforced gate. For dev and demos use `./scripts/seed-dev.sh` (fixture drivers, synthetic Firebase uids, cannot sign in) or the SQL in [RUN-GUIDE](../../manual-testing/RUN-GUIDE.md) section 8.

## User-visible behaviour (driver app)

| Step | Screen | Behaviour | Video |
|---|---|---|---|
| Sign in | `/sign-in` | Phone + SMS code ([auth-and-sessions](auth-and-sessions.md)) | D01 |
| Add vehicle | `/profile`, `/profile/vehicle/add` | Type (`auto`, `bike`, `cab_hatch`, `cab_sedan`), registration number, make, model, colour, seats. List of vehicles with a select action | D02 |
| Select vehicle | `/profile` | Calls `PATCH /v1/drivers/me/vehicle`. Required before going online (otherwise the snackbar "Please select a vehicle before going online") | D02 |
| First online | `/home` | A one-time OEM battery-whitelist sheet explains background-kill risks | D02, D03 |
| Online toggle | `/home` | Label "You are online / offline". Starting the toggle starts an Android foreground service that sends one location fix every 5 s (and only after moving at least 10 m) | D03 |
| Forced offline | `/home` | On `force_offline` the app flips to offline. A banner appears if the OS killed the service within the last 24 h | D03 |
| Earnings | `/earnings` | Placeholder text "Earnings - coming in E7" | D08 |

Scene IDs: [D01 to D03, D08](../videos/driver/INDEX.md).

## API endpoints and socket events

| Endpoint / event | Auth | Notes |
|---|---|---|
| `POST /v1/vehicles` | driver | Body `type, reg_no, make, model, color, seats (>=1)`. 409 `vehicle_reg_exists` if this driver already has that reg no |
| `GET /v1/vehicles` | driver | Own **active** vehicles |
| `PATCH /v1/vehicles/:id` | driver (owner) | Partial update of the same fields. 404 `vehicle_not_found`, 403 `forbidden` |
| `PATCH /v1/drivers/me/vehicle` | driver | Body `{ vehicle_id }` (UUID). Sets `driver.current_vehicle_id` |
| `POST /v1/drivers/online` | driver | Body `{ lat, lng }`. 400 `no_vehicle_selected` without a current vehicle. Returns `{ ok, session_id }` |
| `POST /v1/drivers/offline` | driver | Removes geo + presence, availability `offline` |
| socket `driver:location` (client to server) | driver socket | `{ lat, lng, heading, speed }`. Refreshes geo and `last_seen` (3 s gate). While the driver is bound to a ride also fans out to the ride room (1 Hz) |
| socket `driver_state` (server to client) | on connect | Replay `{ availability, current_ride_id }` if presence exists |
| socket `driver:assignment` (server to client) | on connect and on `driver:sync` | Committed trip from Postgres, or `null` |
| socket `force_offline` (server to client) | sweep | `{ reason: "timeout" }` |

## Data

- Postgres: `driver` (`availability` `offline|online|on_ride`, `current_vehicle_id`, unused `license_no`, `verified_at`, `rating_*`, `total_rides`), `vehicle` (`type` CHECK, `reg_no` **globally unique**, `seats`, `active`).
- Redis: `active_drivers` (GEO set, member = driver uuid, coordinates lng/lat), `driver:state:<id>` hash (`availability`, `last_seen` epoch ms, `session_id`, and `current_ride_id` while on a trip).

Dispatch only considers a driver if: they are in `active_drivers` within the wave radius, `app_user` is an active driver, they hold no `driver_active_assignment` and no live offer, and they have an **active vehicle with `seats >= passengers needed`** (so a one-seat bike is never offered a 3-seat pool). Presence in Redis is the only "online" test; `driver.availability` is informational.

## Policy knobs

[Driver presence](../../POLICY.md#driver-presence): `DRIVER_AUTO_OFFLINE_SWEEP_MS` (15 s, must be whole seconds dividing 60), `DRIVER_STALE_AFTER_MS` (60 s). [Realtime](../../POLICY.md#realtime): `REALTIME_GEO_INDEX_GATE_MS` (3 s; must be shorter than the stale cutoff, enforced as a cross-field rule). [Driver app knobs](../../POLICY.md#driver-app): `locationIntervalMs` 5000, `locationMinMoveMeters` 10, `serviceKillBannerWindowMs` 24 h.

## Code entry points

- API: `modules/vehicles/{vehicles.controller,vehicles.service}.ts` and `dto/`; `modules/drivers/{drivers.controller,drivers.service}.ts` (`goOnline`, `goOffline`, `autoOfflineSweep` with `@Cron`); `modules/realtime/realtime.gateway.ts` (`handleDriverLocation`, `_replayDriverState`).
- Driver app: `lib/core/driver/driver_state_notifier.dart` (online/offline calls, `force_offline` handler), `lib/core/location/foreground_service.dart`, `lib/core/realtime/location_bridge.dart`, `lib/features/home/{home_screen,oem_onboarding_sheet,service_kill_banner}.dart`, `lib/features/profile/*`.

## Tests

API: `vehicles.service.spec.ts`, `drivers.service.spec.ts`; integration `vehicles.int.spec.ts`, `drivers.int.spec.ts`, `realtime-location.int.spec.ts`. Driver app: `test/features/home/`, `test/features/profile/`, `test/core/location/`, `test/core/realtime/`.

## Known gaps

- **No driver provisioning path** and no enforced verification (see above).
- **Duplicate registration number across drivers returns 500.** `vehicle.reg_no` is unique table-wide, but `VehiclesService.create` only pre-checks the same driver, so a second driver registering an existing plate hits the unique constraint and the global filter answers `internal_error` (500) instead of a 409. Proposed fix: catch the unique violation via `pgConstraintViolation()` and throw `vehicle_reg_exists`.
- **Vehicles cannot be deactivated.** `vehicle.active` is read but no endpoint sets it to false; there is no delete.
- `driver:location` writes the geo index and `last_seen` for any authenticated driver socket, even if the driver has already gone offline. A late packet after `POST /v1/drivers/offline` can re-add the driver to `active_drivers` until the next sweep (60 s). The app is expected to stop streaming on offline, so this needs a stray or replayed packet; a server-side guard (ignore location unless `driver:state` exists) is a candidate fix. Not reproduced here, read from `handleDriverLocation`.
- `driver.availability = 'on_ride'` is allowed by the CHECK but nothing writes it; "busy" is `driver_active_assignment`.
- The sweep lists presence with Redis `KEYS driver:state:*`, which is O(keys) and blocking; fine at pilot scale, replace with `SCAN` or an indexed set before the fleet grows.
- A driver forced offline mid-trip loses their Redis presence hash, including the `current_ride_id` projection. The trip itself is safe (it lives in Postgres, the assignment guard stays), but the live-location fan-out to the passenger depends on that projection, so the passenger's map stops updating until the next location packet recreates the hash and the 30 s assignment reconcile re-projects it.
