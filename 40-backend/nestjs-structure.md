---
title: NestJS project structure
tags: [layer/backend]
status: accepted
phase: 0
depends_on: [[tech-stack]], [[service-boundaries]]
related: [[module-map]], [[api-conventions]]
audience: both
---

# NestJS project structure

*One Node app, many modules.*

## Folder layout (inside `apps/api/src/`)

```
apps/api/src/
  main.ts                 # bootstrap
  app.module.ts           # imports all feature modules
  config/                 # env loader, typed config service
  common/                 # filters, guards, interceptors, pipes
    auth/                 #   AuthGuard, RolesGuard
    errors/               #   AppException, error filter
    logging/              #   pino logger
    pagination/           #   cursor pagination helpers
  modules/
    auth/
      auth.module.ts
      auth.controller.ts
      auth.service.ts
      strategies/         #   firebase strategy, google strategy
      dto/
    users/
    clients/
    drivers/
    rides/
    dispatch/
    matching/
    shared-rides/
    rating/               #   RatingController + RatingService — insert built E4.S9; aggregate E7
    geo/
    notifications/
    realtime/             #   Socket.IO gateway + RealtimeBus provider
  infra/
    db/                   #   Drizzle/TypeORM setup, migrations runner
    redis/                #   client + namespaced helpers (queue, geo, pubsub)
    firebase/             #   admin SDK init
    fcm/                  #   typed FCM client
    osrm/                 #   typed OSRM client (route, table)
  types/                  #   shared TS types (imported by `shared/` too)
```

## Bootstrap order

```ts
// main.ts (conceptual — code lives in repo when generated)
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  app.useGlobalFilters(new AppExceptionFilter());
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();
  await app.listen(3000);
}
```

## Module rules

- One feature = one module = one folder.
- A module exposes **one or more service classes** as its public API (registered as `providers` and listed in `exports`).
- Controllers are thin: validate DTO → call service → return DTO.
- All DB access goes through repository classes inside the owning module. No module reaches into another module's repository.
- Cross-cutting infra (DB, Redis, Firebase, FCM, OSRM) lives under `infra/` and is imported as injectable typed clients.

## ORM / query layer

We use **Drizzle ORM** (TypeScript-first, no decorators, easy to read SQL). Migrations are SQL files run by Drizzle's runner. See [[migrations]].

## Configuration

- 12-factor: all config from env. `config/` exposes a typed `AppConfig` service. Never read `process.env` outside `config/`.
- Local `.env` for dev; production gets env from docker-compose `env_file` (see [[secrets-management]]).

## See also
- [[module-map]] · [[api-conventions]]
- [[service-boundaries]] · [[database-choice]] · [[migrations]]
