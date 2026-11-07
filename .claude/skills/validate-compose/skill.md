---
name: validate-compose
description: Validate all Docker Compose file combinations (dev, prod, prod-test) parse correctly. Run after any compose file edit.
---

# validate-compose

Runs `docker compose config --quiet` against every compose file combination in the project. Reports pass/fail for each.

## Inputs

None.

## Steps

1. **Validate dev compose (with obs profile):**
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml --profile obs config --quiet
   ```

2. **Validate dev compose (slim / no profile):**
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml config --quiet
   ```

3. **Validate prod + prod-test overlay:**
   ```bash
   docker compose -f infra/docker/docker-compose.prod.yml -f infra/docker/docker-compose.prod-test.yml config --quiet
   ```

4. **Validate test compose:**
   ```bash
   docker compose -f infra/docker/docker-compose.test.yml config --quiet
   ```

5. **Validate test compose with osrm profile:**
   ```bash
   docker compose -f infra/docker/docker-compose.test.yml --profile osrm config --quiet
   ```

6. **Report results.** Print a table:
   ```
   | Compose combination         | Result |
   |-----------------------------|--------|
   | dev (with obs)              | ✓      |
   | dev (slim)                  | ✓      |
   | prod + prod-test            | ✓      |
   | test                        | ✓      |
   | test (with osrm)            | ✓      |
   ```

   Known warnings to suppress/ignore:
   - `REDIS_PASSWORD variable is not set` on prod-test (expected — set inline by overlay)

## When to use

- After editing any `docker-compose.*.yml` file
- After adding or removing a service
- After changing volume or network definitions
- Before committing infra changes
