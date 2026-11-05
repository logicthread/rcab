---
name: seed-db
description: Seed the dev Postgres database and Redis geo index with fixture drivers, clients, and vehicles for manual testing and demo walkthroughs. Args: [--reset] [--drivers N] [--offline].
---

# seed-db

Populates the dev database with known fixture data so dispatch, matching and the list/earnings
screens have something to work with, without signing up ten users by hand.

Backed by a real script: `scripts/seed-dev.sh`. It talks to Postgres and Redis through
`docker compose exec`, so it needs no host-side client and no published host ports.

## What it CANNOT do (state this to the user before a demo)

- Seeded users have synthetic `firebase_uid` values (`seed-driver-1`, `seed-client-1`, …).
  **They cannot sign in through Firebase phone OTP.** Sign-in still needs a Firebase test
  phone number configured in the Firebase console (see `docs/manual-testing/RUN-GUIDE.md` §3).
- **Accepting an offer needs a real driver signed in on the Flutter app** — `ride_offer_response`
  travels over that driver's WebSocket. Seeded drivers make dispatch *find* candidates and let
  you watch fan-out, wave-2 and hard-fail; they never answer.

## Inputs

- `--reset` — delete previously seeded rows (`firebase_uid LIKE 'seed-%'`) and their Redis
  geo/state entries first. Dev only; it never truncates schema or migration tables.
- `--drivers N` — how many online drivers (default 3).
- `--offline` — create the driver rows but skip the Redis geo index (drivers stay `offline`).

## Steps

1. **Check the stack is up** (the script does this too and exits 1 with the fix):
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml ps postgres --format '{{.Status}}'
   ```

2. **Run the seed.**
   ```bash
   ./scripts/seed-dev.sh                       # 3 online drivers + 2 clients
   ./scripts/seed-dev.sh --reset --drivers 10  # clean slate, 10 drivers
   ./scripts/seed-dev.sh --offline             # rows only, nothing in the geo index
   ```
   Re-running without `--reset` is an upsert — safe and idempotent.

3. **Read back the fixture table** the script prints (drivers, phones, availability, vehicle
   type, reg no, Redis geo member count) and relay it to the user.

4. **Verify the geo index independently** when the next step is dispatch work:
   ```bash
   /redis-inspect     # or: docker compose … exec -T redis redis-cli ZCARD active_drivers
   ```

## Fixture layout

| Thing | Value |
|---|---|
| Driver ids | `00000000-0000-4000-8000-0000000000NN` (NN = 01…) |
| Client ids | `00000000-0000-4000-8000-0000000001NN` |
| Vehicle ids | `00000000-0000-4000-8000-0000000002NN` |
| Phones | `+9199000000NN` (drivers), `+9199000001NN` (clients) |
| Reg numbers | `AS01NNNN` |
| Vehicle types | cycles `auto` (3 seats), `cab_hatch` (4), `cab_sedan` (4), `bike` (1) |
| Positions | scattered ±0.01° around Guwahati `(26.1445, 91.7362)` — inside the dev OSRM extract |

Coordinates **must** stay inside the NE-India OSRM extract or quoting returns `NoRoute`.

## When to use

- Before a demo walkthrough that needs candidate drivers (Demo 3 dispatch, Demo 4 pools, Demo 5 wake)
- After `pnpm dev:down -v` wiped the volumes (re-apply migrations first — they are not automatic)
- Before Playwright e2e specs that expect drivers to exist

## Anti-patterns

- Never `--reset` against anything but the local dev DB.
- Don't invent extra fixture phone numbers ad hoc — extend `scripts/seed-dev.sh` so the next
  session gets the same data.
