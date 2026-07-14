# rcab code graph

Generated 2026-06-15T21:08:07+05:30 @ d0c8a482100f65c3ddf322f634f90a7ac34d5c61. **Do not hand-edit** — run `pnpm code:graph`.

Nodes: 239 (138 file, 16 module, 54 symbol, 22 route, 9 table). Edges: 377 (266 imports, 29 di-import, 32 di-provides, 22 route, 22 riverpod-provides, 6 fk).

> Known v1 limit: import edges are syntactic (per-file), so barrel re-exports may under-resolve.

## NestJS modules (16)

- **AppModule** `apps/api/src/app.module.ts` → AuthModule, DispatchModule, DriversModule, DrizzleModule, FirebaseModule, GoogleModule, HealthModule, RatingModule, RealtimeModule, RedisModule, RideLifecycleModule, RidesModule, VehiclesModule
- **AuthModule** `apps/api/src/modules/auth/auth.module.ts`
- **DispatchModule** `apps/api/src/modules/dispatch/dispatch.module.ts` → MatchingModule, RealtimeModule, RidesModule
- **DriversModule** `apps/api/src/modules/drivers/drivers.module.ts` → AuthModule, RealtimeModule
- **DrizzleModule** `apps/api/src/infra/db/drizzle.module.ts`
- **FirebaseModule** `apps/api/src/infra/firebase/firebase.module.ts`
- **GoogleModule** `apps/api/src/infra/google/google.module.ts`
- **HealthModule** `apps/api/src/modules/health/health.module.ts`
- **MatchingModule** `apps/api/src/modules/matching/matching.module.ts` → RealtimeModule
- **PricingModule** `apps/api/src/modules/pricing/pricing.module.ts`
- **RatingModule** `apps/api/src/modules/rating/rating.module.ts` → AuthModule, RidesModule
- **RealtimeModule** `apps/api/src/modules/realtime/realtime.module.ts` → AuthModule
- **RedisModule** `apps/api/src/infra/redis/redis.module.ts`
- **RideLifecycleModule** `apps/api/src/modules/ride-lifecycle/ride-lifecycle.module.ts` → MatchingModule, RealtimeModule
- **RidesModule** `apps/api/src/modules/rides/rides.module.ts` → AuthModule, MatchingModule, PricingModule, RealtimeModule
- **VehiclesModule** `apps/api/src/modules/vehicles/vehicles.module.ts` → AuthModule

## HTTP routes (22)

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
- `POST /v1/auth/refresh` → AuthController.refresh `apps/api/src/modules/auth/auth.controller.ts`
- `POST /v1/drivers/offline` → DriversController.goOffline `apps/api/src/modules/drivers/drivers.controller.ts`
- `POST /v1/drivers/online` → DriversController.goOnline `apps/api/src/modules/drivers/drivers.controller.ts`
- `POST /v1/rides` → RidesController.create `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/rides/:id/cancel` → RidesController.cancel `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/rides/:id/ratings` → RatingController.rate `apps/api/src/modules/rating/rating.controller.ts`
- `POST /v1/rides/:id/state` → RidesController.transition `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/rides/quote` → RidesController.quote `apps/api/src/modules/rides/rides.controller.ts`
- `POST /v1/vehicles` → VehiclesController.create `apps/api/src/modules/vehicles/vehicles.controller.ts`

## DB tables (9)

- **appUser** (`app_user`)
- **authRefreshToken** (`auth_refresh_token`) → appUser
- **client** (`client`) → appUser
- **driver** (`driver`) → appUser
- **ratings** (`ratings`)
- **rides** (`rides`) → appUser
- **rideStop** (`ride_stops`) → sharedRide
- **sharedRide** (`shared_rides`)
- **vehicle** (`vehicle`) → driver
