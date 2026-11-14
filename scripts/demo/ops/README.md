# Ops and monitoring video harness (scenes M01-M06)

Re-records the onboarding videos in `docs/onboarding/videos/ops/` against the **running dev stack**. Dev only: every URL is
loopback, every credential is a dev-compose default or a throwaway.

```bash
pnpm dev:up                                  # obs profile must be up (grafana, prometheus, loki, alertmanager, uptime-kuma)
pnpm demo:record:ops                         # all scenes, then rewrite videos/ops/INDEX.md
pnpm demo:record:ops -- --scenes M02,M03     # a subset (INDEX.md is rebuilt from the mp4s already on disk)
```

Prerequisites: `k6`, `ffmpeg` (`/opt/homebrew/bin/ffmpeg`, override with `FFMPEG=`), `docker`, and Playwright's Chromium from
`apps/web` (`cd apps/web && npx playwright install chromium`). The dev stack is never stopped or rebuilt by the harness.

## Files

| File | Purpose |
|---|---|
| `record.mjs` | Entry point: preflight (api / grafana / prometheus up, Area C isolation, tools present), runs scenes, always cleans load fixtures, rebuilds `INDEX.md` |
| `scenes.mjs` | One object per scene (`id`, `slug`, title card, `run()`). M01-M05 drive a headless browser; M06 delegates to `terminal.mjs` |
| `lib.mjs` | Recording primitives: Chromium at 1280x720 with Playwright `recordVideo`, injected caption bar, title card, ffmpeg to H.264, k6 launcher |
| `terminal.mjs` | M06: really runs the commands, then replays the captured output as a typed terminal page and records that |
| `config.mjs` | URLs, dev credentials, Area A/B/C coordinates, throwaway container names/ports |
| `kuma-monitors.ts` | Adds demo monitors to the throwaway Uptime Kuma used by M04 |
| `snippets/` | `redis-inspect.sh` and `pool-inspect.sh`: the read-only commands from `.claude/skills/*-inspect` as runnable scripts |

## Scenes

| ID | What the harness does |
|---|---|
| M01 | Logs in to Grafana through its API, runs k6 for about 55 s, walks Overview, Dispatch, Redis and Postgres dashboards |
| M02 | k6 in the background; Prometheus targets, `rcab_dispatch_outcome_total`, `rcab_ride_state_transition_total`, route-template p95, alert rules |
| M03 | Sends a quote and an unauthenticated request with our own `x-request-id`, then finds both in Loki (Logs dashboard and Explore) |
| M04 | Starts a throwaway Uptime Kuma on `127.0.0.1:3013`, sets it up, adds monitors (one deliberately failing), records, removes it |
| M05 | Starts a throwaway `socat` forward to Alertmanager (it publishes no host port), injects one labelled `RcabDemoAlert`, resolves it, removes the forward |
| M06 | Runs `pnpm dev:smoke`, `obs:smoke`, `system:probe --ci`, the redis/pool inspect snippets, `policy:doc:check`, `backup-rehearsal.sh`; replays them typed |

## Safety rules the harness enforces

- **Area C only.** k6 drivers and riders are parked at Guwahati Area C (26.115, 91.70) through `LOAD_BASE_LAT` / `LOAD_BASE_LNG`
  (`infra/load/prepare-dev.mjs --base-lat/--base-lng`). `record.mjs` aborts if Area C is within `dispatch.r2Meters`
  ([docs/POLICY.md](../../../docs/POLICY.md)) of Area A (26.1445, 91.7362) or B (26.18, 91.79), so load never competes with app demos.
- **No backdoor.** Fixture sessions are ordinary signed tokens minted by `infra/load/prepare-dev.mjs`, which refuses production,
  non-loopback and non-dev compose. Nothing in the shipped api or web was changed for the recordings.
- **Cleanup.** `record.mjs` always runs `prepare-dev.mjs --clean` (slow: one docker exec per fixture driver) and removes its own
  containers (`rcab-demo-kuma`, `rcab-demo-am-forward`) and the one shared pool M06 opens.
- Do not `pkill` browsers or `prepare-dev` globally: other recording harnesses use the same machine.

## Dev-only credentials

Grafana `admin` / `admin` (from `infra/docker/docker-compose.dev.yml`); throwaway Uptime Kuma `admin` / `admin1234!`.

## Troubleshooting

- `grafana login failed`: check `curl -u admin:admin localhost:3001/api/user`; the harness logs in through `POST /login`.
- Empty panels: Prometheus needs about 30 s of k6 traffic; check `localhost:9090/targets` (api, redis, postgres all UP).
- Loki shows nothing: promtail ships container stdout every few seconds; `request_id` is a parsed JSON field, not a label
  (`| json | request_id = "<id>"`), see `infra/observability/promtail.yml`.
- Output goes to `$TMPDIR/rcab-demo-ops` (override with `DEMO_WORK_DIR`); k6 logs are in `k6-<scene>.log` there.
