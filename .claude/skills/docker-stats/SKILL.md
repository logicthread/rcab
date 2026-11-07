---
name: docker-stats
description: Snapshot per-container CPU and memory usage across the dev stack. Compare against Phase-0 VPS resource budget. No args.
---

# docker-stats

The Phase-0 VPS has finite resources (see [[performance-budget]]). This skill takes a one-shot snapshot of container resource usage and flags anything over budget, so you catch resource creep before it becomes a prod incident.

## Inputs

None.

## Steps

1. **Take a 3-second snapshot** (3 samples, then stop — avoids a blocking stream).
   ```bash
   docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}' 2>/dev/null
   ```

2. **Parse and annotate against Phase-0 budget.**
   Budget (from [[performance-budget]]):
   | Container | CPU budget | Mem budget |
   |-----------|-----------|------------|
   | api       | ≤ 30%     | ≤ 512 MB   |
   | web       | ≤ 10%     | ≤ 256 MB   |
   | postgres  | ≤ 20%     | ≤ 512 MB   |
   | redis     | ≤ 5%      | ≤ 128 MB   |
   | osrm      | ≤ 40%     | ≤ 1.5 GB   |
   | loki      | ≤ 5%      | ≤ 256 MB   |
   | prometheus| ≤ 5%      | ≤ 256 MB   |
   | grafana   | ≤ 5%      | ≤ 256 MB   |

3. **Print annotated table.**
   ```
   | Container  | CPU    | Memory       | Budget | Status |
   |------------|--------|--------------|--------|--------|
   | api        | 12%    | 180 MB       | ≤512   | ✓      |
   | osrm       | 38%    | 1.2 GB       | ≤1.5G  | ✓      |
   | postgres   | 3%     | 610 MB       | ≤512   | ✗ OVER |
   ```
   Any container over its budget is marked ✗ OVER.

4. **Sum total memory** and compare to the VPS available memory (default assume 4 GB; overridable via `VPS_MEMORY_GB` env var).
   ```
   Total memory in use: 2.9 GB / 4 GB (72%) ✓
   ```

5. If any container is OVER, suggest actions:
   - Postgres over mem: `SHOW shared_buffers;` — may need tuning in `postgresql.conf`.
   - OSRM over mem: check PBF extract size; consider a smaller region for dev.
   - API over mem: check for memory leaks; run `node --inspect` profiling.

## When to use

- Before a demo walk (resource sanity check)
- After adding a new service to docker-compose
- When the VPS feels slow and you want to diagnose the culprit
- During `/k6-load` to watch resource consumption under load

## Notes

- `docker stats --no-stream` takes a single sample at a random moment; CPU % is averaged over the last sampling interval. Rerun if a value looks anomalous.
- Container names include the compose project prefix (e.g., `rcab-api-1`). The skill matches by suffix.
