---
title: RCAB-E3.S3 — Vehicle registration screen + API
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e3-driver-presence]]
demo: 2
estimate: m
hitl: no
depends_on: [[story-rcab-e3-s1-flutter-app-skeleton]], [[entity-vehicle]], [[entity-driver]], [[rest-endpoints]]
blocks: [[story-rcab-e3-s4-driver-online-toggle]]
affected_notes: [[rest-endpoints]], [[entity-vehicle]], [[entity-driver]]
owner: claude
audience: both
---

# RCAB-E3.S3 — Vehicle registration screen + API

## Goal

Two-part story. **API**: implement the `vehicles` endpoints and the Drizzle migration that creates the `vehicles` table (per [[entity-vehicle]]) and adds `current_vehicle_id` to the `drivers` table (per [[entity-driver]]). **Flutter**: build the `/profile` screen with a vehicle list and a vehicle form, allowing drivers to add a vehicle and select one as the active vehicle. A driver must have a selected vehicle (`current_vehicle_id` set) before going online — this is the gate enforced in RCAB-E3.S4.

## User-facing acceptance criteria

- `Given` I open `/profile`, `When` I have no registered vehicles, `Then` I see an empty state with an "Add vehicle" button.
- `Given` I tap "Add vehicle" and fill in type, reg_no, make, model, color, and seats, `When` I submit, `Then` the vehicle is saved and appears in my vehicle list.
- `Given` I have at least one vehicle, `When` I tap "Select" on a vehicle row, `Then` it becomes my active vehicle (checkmark shown) and `PATCH /v1/drivers/me/vehicle` is called with the vehicle ID.
- `Given` I submit the add-vehicle form with a blank reg_no, `When` validation runs, `Then` an inline error "Registration number required" prevents submission.
- `Given` I submit with a reg_no already registered to my account, `When` the server rejects it, `Then` a snackbar shows "You already have a vehicle with that registration number."

## Technical acceptance criteria

### API

- Drizzle migration `XXXX_create_vehicles.ts`:
  - `vehicles` table with columns from [[entity-vehicle]]: `id` (uuid v7, pk), `driver_id` (uuid, fk → `drivers.user_id`), `type` (enum `auto | bike | cab_hatch | cab_sedan`), `reg_no` (text, unique), `make` (text), `model` (text), `color` (text), `seats` (int), `active` (bool default true), `created_at` (timestamptz default now).
  - `drivers.current_vehicle_id` (uuid nullable, fk → `vehicles.id`) added if not already present in the `drivers` table schema.
- `modules/vehicles/vehicles.module.ts`, `vehicles.controller.ts`, `vehicles.service.ts`:
  - `POST /v1/vehicles` 🔒🚗 — body `{ type, reg_no, make, model, color, seats }`; validates `type` against enum; returns created vehicle; `409 vehicle_reg_exists` if `reg_no` already on file for this driver.
  - `GET /v1/vehicles` 🔒🚗 — returns array of driver's vehicles (active only by default).
  - `PATCH /v1/vehicles/:id` 🔒🚗 — partial update; driver can only update their own vehicle (`403` otherwise).
- `modules/drivers/drivers.controller.ts` + `drivers.service.ts`:
  - `PATCH /v1/drivers/me/vehicle` 🔒🚗 — body `{ vehicle_id }`; validates the vehicle belongs to the requesting driver; sets `drivers.current_vehicle_id`; returns updated driver profile.

### Flutter

- `lib/features/profile/profile_screen.dart` — vehicle list using `GET /v1/vehicles`; each row shows type + reg_no + active badge; "Select" button calls `PATCH /v1/drivers/me/vehicle` and updates local `driverStateProvider` (or a `vehicleProvider`); "Add" FAB opens vehicle form.
- `lib/features/profile/vehicle_form_screen.dart` — form fields: `type` (DropdownButtonFormField with enum values), `reg_no` (TextFormField, required), `make` (TextFormField, required), `model` (TextFormField, required), `color` (TextFormField, required), `seats` (TextFormField, int, min 1). On submit calls `POST /v1/vehicles`.
- Vehicle DTOs generated with `freezed` + `json_serializable` in `lib/features/profile/models/vehicle.dart`.

## Test plan

- Unit (Vitest): `VehicleService` — mock Drizzle; assert vehicle create with valid payload; assert `409` on duplicate `reg_no` for same driver.
- Unit (Vitest): `DriversService.setCurrentVehicle` — assert ownership check (driver A cannot set driver B's vehicle); assert Postgres update called.
- Integration (Testcontainers Postgres): full round-trip `POST /v1/vehicles` → `GET /v1/vehicles` → `PATCH /v1/drivers/me/vehicle`; verify `current_vehicle_id` set on driver row.
- Widget (Flutter): `test/features/profile/profile_screen_test.dart` — mock API responses; assert empty state renders; assert vehicle row appears after add; assert "Select" calls PATCH.
- Widget (Flutter): `test/features/profile/vehicle_form_screen_test.dart` — assert validation rejects blank `reg_no`; assert submit calls `POST /v1/vehicles`.

## Out of scope

- Vehicle deletion / deactivation — `/profile` shows only `active=true` vehicles; deactivation is a future story.
- Vehicle verification or document upload — Phase-0 only requires registration of the fields from [[entity-vehicle]].
- Enforcement of "must have vehicle before going online" — that is the responsibility of RCAB-E3.S4 (`POST /v1/drivers/online` rejects if `current_vehicle_id` is null).

## Notes / questions

- The `drivers` table may already have `current_vehicle_id` as a nullable column if it was scaffolded as part of E1 database bootstrap. Check the existing migration state before generating a new one — the Drizzle migration must be idempotent or guarded.
- `reg_no` is unique across all drivers globally (`unique` constraint on the column). Confirm with the team whether a driver can re-register a vehicle that was previously marked `active=false` by another driver — for Phase-0 a simple global uniqueness constraint is sufficient.

## See also

- [[epic-e3-driver-presence]] · [[entity-vehicle]] · [[entity-driver]] · [[rest-endpoints]]
- [[story-rcab-e3-s1-flutter-app-skeleton]] · [[story-rcab-e3-s4-driver-online-toggle]]
