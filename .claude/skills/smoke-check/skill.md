---
name: smoke-check
description: Run dev and observability smoke checks, report per-service health table. No args.
---

# smoke-check

Quick health check across the entire dev stack. Reports a per-service status table instead of raw log output.

## Inputs

None.

## Steps

1. **Check Docker is running.**
   ```bash
   docker info --format '{{.ServerVersion}}' 2>/dev/null
   ```
   If Docker isn't running, stop and tell the user.

2. **Get container status.** (`--profile obs` is required or the observability containers are
   silently omitted from the listing.)
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml --profile obs ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'
   ```

3. **Run dev smoke test.**
   ```bash
   pnpm dev:smoke
   ```
   Capture the exit code and output.

4. **Run observability smoke test** (if obs profile is active):
   ```bash
   pnpm obs:smoke 2>/dev/null || echo "obs profile not active"
   ```

5. **Hit individual health endpoints.**
   ```bash
   curl -s -o /dev/null -w '%{http_code} %{time_total}s' http://localhost:3000/v1/health/live
   curl -s -o /dev/null -w '%{http_code} %{time_total}s' http://localhost:3000/v1/health/ready
   ```

6. **Report a summary table.**
   ```
   | Service    | Container | Health endpoint | Latency |
   |------------|-----------|-----------------|---------|
   | postgres   | running   | n/a (compose)   | —       |
   | redis      | running   | n/a (compose)   | —       |
   | osrm       | running   | n/a (compose)   | —       |
   | api        | running   | 200 /ready      | 45ms    |
   | web        | running   | n/a              | —       |
   | loki       | running   | 200              | 30ms    |
   | prometheus | running   | 200              | 20ms    |
   | grafana    | running   | 200              | 50ms    |
   ```
   Mark any non-200 or missing container as FAIL.

## When to use

- After `pnpm dev:up` to verify the stack is healthy
- After restarting containers or applying migrations
- As a quick sanity check before starting a story
