---
name: osrm-check
description: Verify the OSRM routing container is healthy, has loaded its routing graph, and can return a valid route for a test coordinate pair. No args.
---

# osrm-check

OSRM is the backbone of route quoting (E4) and shared-ride scoring (E5). This skill confirms it is up, loaded, and returning sane results before any routing-dependent story work begins.

## Inputs

None.

**OSRM publishes no host port in `docker-compose.dev.yml`** — it is reachable only inside
`rcab_dev_net` at `http://osrm:5000`. Probe it from a container on that network (the api
container has `curl`), never from `localhost:5000`.

Define once per shell:

```bash
DC="docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml"
```

## Steps

1. **Container health.**
   ```bash
   $DC ps osrm --format '{{.Status}}'
   ```
   Must include `Up`. If not, stop and instruct user to run `pnpm dev:up`.

2. **Graph loaded + route query.** The dev graph is the **NE-India (Guwahati) extract** —
   coordinates outside it return `NoRoute` even when OSRM is perfectly healthy. Use
   Guwahati CBD → Six Mile:
   ```bash
   $DC exec -T api sh -c 'curl -s "http://osrm:5000/route/v1/driving/91.7362,26.1445;91.7898,26.1758?overview=full&geometries=geojson"' \
     | jq '{code, distance: .routes[0].distance, duration: .routes[0].duration, polyline_points: (.routes[0].geometry.coordinates | length)}'
   ```
   Assertions:
   - `.code == "Ok"`
   - `.routes[0].distance > 0`
   - `.routes[0].geometry.coordinates | length > 2` (a real polyline, not just endpoints)

3. **Cross-check the API's own view** (the api `/ready` probe reports `osrm`):
   ```bash
   curl -s http://localhost:3000/v1/health/ready | jq
   ```
   Expect `"osrm": true`.

4. **Report.**
   ```
   OSRM check
   ──────────
   Container:    Up ✓
   Route code:   Ok ✓
   Test route:   4.2 km, 8 min, 47 polyline points ✓
   api /ready:   osrm: true ✓
   ```
   If any check fails, print the raw response for debugging.

## When to use

- Before implementing any routing-dependent story (E4.S1, E5.S1+)
- After `pnpm dev:up` when OSRM takes longer to load its graph than other services
- If `/smoke-check` shows OSRM container as `Up` but routing calls return empty polylines

## Notes

- Bring-up order is `osrm-prep` → `osrm-extract` (both run to completion and exit) → `osrm`.
  A first run downloads and pre-processes the PBF and can take several minutes; check
  `$DC logs osrm-extract` if the route call fails right after `dev:up`.
- OSRM loads the pre-processed `.osrm` graph on startup; the container is `Up` before the
  graph is ready. Step 2 is what distinguishes "container up" from "graph loaded".
- `NoRoute` on in-region coordinates means the graph is fine but the points are unsnappable
  (middle of a river, etc.) — move them onto a road before concluding OSRM is broken.
