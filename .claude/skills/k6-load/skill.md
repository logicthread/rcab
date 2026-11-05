---
name: k6-load
description: Run k6 load tests against the local or prod stack and compare results against the Phase-0 performance budget. Args: [scenario] [--target=local|prod].
---

# k6-load

Runs k6 load tests and compares results against the performance budget defined in the vault (`90-quality/performance-budget.md`).

## Inputs

- `$1` (optional): scenario name — maps to a k6 script in `tests/load/` or `apps/api/test/load/`. If omitted, runs all scenarios.
- `--target=local` (default) or `--target=prod`: which stack to hit.

## Steps

1. **Check k6 is available.**
   ```bash
   k6 version 2>/dev/null || brew install grafana/tap/k6
   ```

2. **Find test scripts.**
   ```bash
   find . -path '*/load/*.js' -o -path '*/load/*.ts' | head -20
   ```
   If no scripts found, report and stop — load tests haven't been written yet (expected before E8.S5).

3. **Read the performance budget.** Load `90-quality/performance-budget.md` to extract target thresholds (p95 latency, error rate, throughput).

4. **Set the target base URL.**
   - `local`: `http://localhost:3000`
   - `prod`: read from `.env.prod` or ask the user.

5. **Run k6.**
   ```bash
   k6 run --out json=results.json <script> --env BASE_URL=<target>
   ```

6. **Parse results.** Extract from the JSON output:
   - `http_req_duration` p50, p95, p99
   - `http_req_failed` rate
   - `iterations` total and per-second
   - `vus_max`

7. **Compare against budget.** For each metric, compare against the vault's performance budget and report pass/fail:
   ```
   | Metric              | Budget   | Actual   | Result |
   |---------------------|----------|----------|--------|
   | p95 latency (ms)    | < 200    | 145      | PASS   |
   | Error rate           | < 1%     | 0.2%     | PASS   |
   | Throughput (rps)     | > 100    | 156      | PASS   |
   ```

## When to use

- E8.S5 acceptance criteria sign-off
- After performance-sensitive changes (dispatch, matching, geo queries)
- Before demo 7 sign-off

## Anti-patterns

- Don't run load tests against prod without explicit user permission (HITL stop).
- Don't run while other heavy tests are running — results will be noisy.
