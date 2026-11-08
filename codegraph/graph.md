# rcab code graph

Generated 2026-11-07T17:35:02+05:30 @ c4820cddf41084958c663694a8c0cf1235ce99ad. **Do not hand-edit** — run `pnpm code:graph`.

Nodes: 308 (181 file, 20 module, 67 symbol, 25 route, 15 table). Edges: 621 (469 imports, 43 di-import, 46 di-provides, 25 route, 22 riverpod-provides, 16 fk).

> Known v1 limit: import edges are syntactic (per-file), so barrel re-exports may under-resolve.

## NestJS modules (20)

- **AppModule** `apps/api/src/app.module.ts` → AuthModule, DispatchModule, DispatchRunnerModule, DriversModule, DrizzleModule, FirebaseModule, GoogleModule, HealthModule, OutboxModule, PolicyModule, RatingModule, RealtimeModule, RedisModule, RideLifecycleModule, RidesModule, ScheduledModule, VehiclesModule
- **AuthModule** `apps/api/src/modules/auth/auth.module.ts`
- **DispatchModule** `apps/api/src/modules/dispatch/dispatch.module.ts` → MatchingModule, RealtimeModule, RidesModule
- **DispatchRunnerModule** `apps/api/src/modules/dispatch/dispatch-runner.module.ts` → DispatchModule, MatchingModule, OutboxModule, RidesModule, ScheduledModule
- **DriversModule** `apps/api/src/modules/drivers/drivers.module.ts` → AuthModule, RealtimeModule
- **DrizzleModule** `apps/api/src/infra/db/drizzle.module.ts`
- **FirebaseModule** `apps/api/src/infra/firebase/firebase.module.ts`
- **GoogleModule** `apps/api/src/infra/google/google.module.ts`
- **HealthModule** `apps/api/src/modules/health/health.module.ts`
- **MatchingModule** `apps/api/src/modules/matching/matching.module.ts` → OutboxModule, RealtimeModule
- **OutboxModule** `apps/api/src/modules/outbox/outbox.module.ts` → ScheduledModule
- **PolicyModule** `apps/api/src/config/policy/policy.module.ts`
- **PricingModule** `apps/api/src/modules/pricing/pricing.module.ts`
- **RatingModule** `apps/api/src/modules/rating/rating.module.ts` → AuthModule, RidesModule
- **RealtimeModule** `apps/api/src/modules/realtime/realtime.module.ts` → AuthModule
- **RedisModule** `apps/api/src/infra/redis/redis.module.ts`
- **RideLifecycleModule** `apps/api/src/modules/ride-lifecycle/ride-lifecycle.module.ts` → DispatchModule, MatchingModule, RealtimeModule
- **RidesModule** `apps/api/src/modules/rides/rides.module.ts` → AuthModule, MatchingModule, OutboxModule, PricingModule, RealtimeModule, ScheduledModule
- **ScheduledModule** `apps/api/src/modules/scheduled/scheduled.module.ts`
- **VehiclesModule** `apps/api/src/modules/vehicles/vehicles.module.ts` → AuthModule

## HTTP routes (25)

- `GET /` → HealthController.rootReady `apps/api/src/modules/health/health.controller.ts`
- `GET /metrics` → HealthController.metrics `apps/api/src/modules/health/health.controller.ts`
- `GET /v1/health/live` → HealthController.live `apps/api/src/modules/health/health.controller.ts`
- `GET /v1/health/ready` → HealthController.ready `apps/api/src/modules/health/health.controller.ts`
- `GET /v1/rides/:id` → RidesController.getRide `apps/api/src/modules/rides/rides.controller.ts`
- `GET /v1/rides/:id/stops` → RidesController.listStops `apps/api/src/modules/rides/rides.controller.ts`
- `GET /v1/vehicles` → VehiclesController.findAll `apps/api/src/modules/vehicles/vehicles.controller.ts`
- `PATCH /v1/drivers/me/vehicle` → DriversController.setVehicle `apps/api/src/modules/drivers/drivers.controller.ts`
- `PATCH /v1/vehicles/:id` → VehiclesController.update `apps/api/src/modules/vehicles/vehicles.controller.ts`
- `POST /v1/auth/firebase-exchange` → AuthController.firebaseExchange `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/auth/google/link` → AuthController.googleLink `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/auth/google/login` → AuthController.googleLogin `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/auth/logout` → AuthController.logout `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/auth/native/firebase-exchange` → AuthController.nativeFirebaseExchange `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/auth/native/logout` → AuthController.nativeLogout `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/auth/native/refresh` → AuthController.nativeRefresh `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/auth/refresh` → AuthController.refresh `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/drivers/offline` → DriversController.goOffline `apps/api/src/modules/drivers/drivers.controller.ts`
- `POST /v1/drivers/online` → DriversController.goOnline `apps/api/src/modules/drivers/drivers.controller.ts`
- `POST /v1/rides` → RidesController.create `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/rides/:id/cancel` → RidesController.cancel `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/rides/:id/ratings` → RatingController.rate `apps/api/src/modules/rating/rating.controller.ts`
- `POST /v1/rides/:id/state` → RidesController.transition `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/rides/quote` → RidesController.quote `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/vehicles` → VehiclesController.create `apps/api/src/modules/vehicles/vehicles.controller.ts`

## DB tables (15)

- **appUser** (`app_user`)
- **authRefreshToken** (`auth_refresh_token`) → appUser
- **client** (`client`) → appUser
- **dispatchOffer** (`dispatch_offer`) → driver, rides, sharedRide
- **driver** (`driver`) → appUser
- **driverActiveAssignment** (`driver_active_assignment`) → dispatchOffer, driver, rides, sharedRide
- **idempotencyRecord** (`idempotency_record`) → appUser
- **migrationConflict** (`migration_conflict`)
- **outbox** (`outbox`)
- **poolMember** (`pool_member`) → appUser, sharedRide
- **ratings** (`ratings`)
- **rides** (`rides`) → appUser
- **rideStop** (`ride_stops`) → sharedRide
- **sharedRide** (`shared_rides`)
- **vehicle** (`vehicle`) → driver
