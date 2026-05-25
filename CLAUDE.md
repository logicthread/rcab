# rcab — Claude Code session contract

This file is auto-loaded into every Claude Code session in this repo. Keep it short. The vault under `00-index/`, `10-product/`, … is the source of truth for *everything else*.

## Vault discipline (read once, every session)

The vault is selective-context: never read it all. Use the index:

1. `00-index/LLM-INSTRUCTIONS.md` — non-negotiable rules.
2. `00-index/reading-paths.md` — task → minimum note set. **Always map your task to one of its slugs and load only the listed notes (plus their `depends_on:`, depth 2). Stop.**
3. `00-index/HOME.md` — human-facing MOC, browse for orientation only.

If your task doesn't match a reading-path, add one to `reading-paths.md` first.

## Delivery layer (drives the work)

| File | Use it when |
|---|---|
| `95-delivery/delivery-roadmap.md` | Picking up a new demo / orienting on overall path |
| `95-delivery/stories-index.md` | Choosing the next story (`□ ready` only) |
| `95-delivery/demo-cadence.md` | Story-done / demo-done definitions |
| `95-delivery/hitl-touchpoints.md` | **Before risky actions — must consult.** |
| `95-delivery/commit-story-linkage.md` | Commit message shape (mandatory `Story:` trailer) |
| `95-delivery/impact-analysis.md` | Mid-flight scope change |
| `95-delivery/story-template.md` | Adding a new story file |

## Commit convention (enforced by hook)

```
<type>(<scope>): <subject>

<body — what & why>

Story: RCAB-Ex.Sy
Sign-off: <name>   # only when a demo or HITL stop signs off
```

`<type>` ∈ `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.
`<scope>` ∈ `vault`, `api`, `web`, `driver-app`, `infra`, `shared`, `ci`, or omit.

The `Story:` trailer is **mandatory** when a commit touches any non-vault path. A PreToolUse hook (`.claude/hooks/check-story-trailer.sh`) blocks `git commit` if missing.

## Hard stops (Claude must ask before)

(Full list: `95-delivery/hitl-touchpoints.md`. Summary:)

- Installing a new system-level package (brew, apt, corepack switches).
- Creating, superseding, or revising an ADR (`99-decisions/`).
- Deploying to a real VPS (any demo ≥ 7).
- Touching secrets handling or the `secrets-management` note.
- Adding a new external service with cost/vendor lock-in.
- Bumping a demo's headline; reordering or splitting epics.
- A test going flaky enough to consider quarantine.
- A story's acceptance criteria changing mid-flight.
- Walking through any demo for sign-off.

## Phase-0 = single VPS, single docker-compose

If a story tempts you toward multi-host, Kubernetes, managed-cloud-this-or-that, stop — this is out of Phase-0 scope per `99-decisions/ADR-0009-single-vps-phase-0.md`. Flag it as an impact-analysis trigger and ask.

## Dev stack — the loop

```bash
pnpm dev:up      # docker compose up -d --build (auto-creates .env.dev on first run)
pnpm dev:smoke   # polls api / → 200 once postgres + redis are connected
pnpm dev:logs    # docker compose logs -f
pnpm dev:down    # tear down
```

Workspace: pnpm 10 (Node ≥20) + Turborepo. Driver app (`apps/driver-app/`) is Flutter and lives outside the pnpm workspace.

## Tests

Integration tests use real containers via Testcontainers (no mocks of infra). e2e: Playwright for web; Flutter `integration_test` for driver. Load: k6 in a sidecar. See `90-quality/testing-strategy.md` once you load it via a reading-path.

## When in doubt

- Read `00-index/reading-paths.md` over guessing.
- Ask the user (HITL) over inventing a non-vault convention.
- Add a stub note before leaving a dangling `[[link]]`.
- Prefer the `Explore` subagent for any vault search >3 grep calls.

## Project skills (this repo)

- `/pickup-story RCAB-Ex.Sy` — orient on a ready story per `path:work-a-story`.
- `/close-story RCAB-Ex.Sy` — verify + status-flip + draft commit.
