# rcab

Ride-hailing for tier-2/3 Indian cities. Shared rides on common routes, normal bookings, and scheduled rides. Web-first client app; Flutter driver app.

Architecture lives in the Obsidian vault at this repo root (`00-index/HOME.md`).

---

## Prerequisites

| Tool | Minimum | Install |
|---|---|---|
| Node.js | 20 | [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm) |
| pnpm | 10 (`packageManager` pins 10.33.4) | `corepack enable pnpm` |
| Docker + compose | 26 / v2 | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Flutter | 3.16 | `brew install --cask flutter` (needed for driver-app only) |
| git | any | system |

---

## Bring-up (JS/TS workspaces)

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Build every workspace (shared → api, web in dependency order)
pnpm build

# 3. Run all unit tests
pnpm test

# 4. Lint
pnpm lint
```

## Driver app (Flutter)

```bash
cd apps/driver-app
flutter pub get
flutter analyze
flutter test
```

## Dev stack (Docker)

```bash
pnpm dev:up      # build + start everything (auto-creates .env.dev on first run)
pnpm dev:smoke   # wait for api / → 200 with postgres + redis connected
pnpm dev:logs    # follow logs
pnpm dev:down    # tear down
```

`dev:up` / `dev:logs` / `dev:down` include the observability stack (`obs` profile);
the `dev:up:slim` / `dev:down:slim` variants skip it.

Host ports: api `3000`, web `3002`, redis `6379`, postgres `55432` (not `5432` —
that host port is usually a local Postgres install); with `obs`: grafana `3001`,
uptime-kuma `3003`, prometheus `9090`. OSRM, Loki and Alertmanager publish no host
port — reach them inside `rcab_dev_net` with `docker compose exec`.

Migrations are hand-authored SQL in `apps/api/migrations/` and are **not** applied
on restart:

```bash
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml \
  exec api npx tsx src/migrate.ts
```

## Repository layout

```
rcab/
  apps/
    api/          # NestJS backend (port 3000)
    web/          # Next.js 14 client (port 3002 on the host)
    driver-app/   # Flutter Android driver app
  packages/
    shared/       # Shared TypeScript types + Zod schemas
    api-client/   # Generated typed API client
  infra/
    docker/       # docker-compose files (dev / test / prod)
    nginx/        # reverse proxy config
  00-index/ … 99-decisions/   # Obsidian architecture vault
```

## Monorepo commands (via Turborepo)

| Command | What it does |
|---|---|
| `pnpm build` | Build all TS workspaces in dependency order |
| `pnpm test` | Run all unit tests (vitest) |
| `pnpm test:int` | Testcontainers integration tests |
| `pnpm test:e2e` | Playwright e2e (web) |
| `pnpm verify` | The story-done gate: lint + api coverage floor + integration |
| `pnpm lint` | ESLint across all TS workspaces |
| `pnpm dev` | Start all dev servers concurrently |
| `pnpm system:probe` | Host capability + load estimate (RCAB-E1.S9) |

## Architecture

See the vault: open `00-index/HOME.md` in [Obsidian](https://obsidian.md/) or any Markdown reader.

Quick links:
- [Vision](10-product/vision.md)
- [System overview](20-architecture/system-overview.md)
- [Delivery roadmap](95-delivery/delivery-roadmap.md)
- [Stories backlog](95-delivery/stories-index.md)
