# rcab

Ride-hailing for tier-2/3 Indian cities. Shared rides on common routes, normal bookings, and scheduled rides. Web-first client app; Flutter driver app.

Architecture lives in the Obsidian vault at this repo root (`00-index/HOME.md`).

---

## Prerequisites

| Tool | Minimum | Install |
|---|---|---|
| Node.js | 20 | [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm) |
| pnpm | 9 | `corepack enable pnpm` |
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
# Coming in RCAB-E1.S2 — docker-compose.dev.yml
docker compose -f infra/docker/docker-compose.dev.yml up
```

## Repository layout

```
rcab/
  apps/
    api/          # NestJS backend (port 3000)
    web/          # Next.js 14 client (port 3001)
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
| `pnpm test` | Run all unit + integration tests |
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
