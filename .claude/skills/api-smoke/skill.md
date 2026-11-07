---
name: api-smoke
description: Hit all API health and readiness endpoints, report per-service latency and status. More targeted than pnpm dev:smoke. No args.
---

# api-smoke

Targeted health probe for the API layer. Unlike `pnpm dev:smoke` (which polls until ready), this reports current state with latency numbers — useful mid-development to verify a module restart didn't break another service.

## Inputs

None.

## Steps

1. **Probe the API health endpoints.**
   ```bash
   curl -s -w '\n%{http_code} %{time_total}' http://localhost:3000/v1/health/live
   curl -s -w '\n%{http_code} %{time_total}' http://localhost:3000/v1/health/ready
   ```

2. **Probe internal service readiness** (from the `/ready` response body, which reports per-dependency status):
   Parse the JSON response to extract individual checks (postgres, redis, osrm).

3. **Probe OSRM** (if running). **No host port** — probe from inside `rcab_dev_net`, and
   keep coordinates inside the NE-India (Guwahati) dev graph:
   ```bash
   DC="docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml"
   $DC exec -T api sh -c 'curl -s -w "\n%{http_code} %{time_total}" "http://osrm:5000/route/v1/driving/91.7362,26.1445;91.7898,26.1758?overview=false"'
   ```

4. **Probe observability stack** (only if the `obs` profile is up). Prometheus, Grafana and
   Uptime-Kuma publish host ports; **Loki, promtail and alertmanager do not** — reach Loki
   through the network:
   ```bash
   curl -s -o /dev/null -w '%{http_code} %{time_total}s' http://localhost:9090/-/ready      # Prometheus
   curl -s -o /dev/null -w '%{http_code} %{time_total}s' http://localhost:3001/api/health   # Grafana
   curl -s -o /dev/null -w '%{http_code} %{time_total}s' http://localhost:3003/            # Uptime-Kuma
   $DC exec -T prometheus sh -c 'wget -qO- http://loki:3100/ready'                          # Loki
   ```

5. **Report a summary table.**
   ```
   | Endpoint                    | Status | Latency  |
   |-----------------------------|--------|----------|
   | /v1/health/live             | 200    | 12ms     |
   | /v1/health/ready            | 200    | 45ms     |
   |   → postgres                | OK     | (incl.)  |
   |   → redis                   | OK     | (incl.)  |
   |   → osrm                    | OK     | (incl.)  |
   | OSRM /route (in-network)    | 200    | 89ms     |
   | Prometheus /-/ready         | 200    | 15ms     |
   | Grafana /api/health         | 200    | 50ms     |
   | Uptime-Kuma /               | 200    | 40ms     |
   | Loki /ready (in-network)    | ready  | —        |
   ```

## When to use

- Quick sanity check after restarting the API container
- After applying migrations to verify API reconnected to Postgres
- Debugging latency issues — the per-endpoint timings help isolate which service is slow
