# Workflow: story lifecycle

rcab is delivered as **stories** grouped into **epics** that end in a **demo**. The Obsidian vault (the numbered
folders at the repo root) is the planning and design source of truth; the code is the source of truth for behaviour.
When they disagree, fix the vault note in the same PR (this onboarding pack found and fixed several such drifts).

## 1. The vault, and how to read only what you need

Never read the whole vault. The entry sequence is:

1. [`00-index/LLM-INSTRUCTIONS.md`](../../../00-index/LLM-INSTRUCTIONS.md) — non-negotiable rules (written for AI
   contributors, equally good for humans).
2. [`00-index/reading-paths.md`](../../../00-index/reading-paths.md) — maps a task to the **minimum note set**
   (`path:work-a-story`, `path:implement-normal-booking`, `path:implement-shared-booking`, …). Load only those
   notes plus their `depends_on:` frontmatter links, two hops deep. If no path matches your task, add one first.
3. [`00-index/HOME.md`](../../../00-index/HOME.md) — human map of content; browse for orientation only.

Folder meaning: `10-product` what and why, `20-architecture` topology, `30-domain` entities and state machines,
`40-backend` modules/REST/WebSocket/schema, `50-clients` web and driver app, `60-integrations` Firebase/OSRM/maps,
`70-algorithms` dispatch/matching, `80-infrastructure` Docker/CI/observability/secrets, `90-quality` testing and
budgets, `95-delivery` the work-tracking layer, `99-decisions` ADRs.

## 2. The delivery layer

| File | Use it when |
|---|---|
| [`95-delivery/delivery-roadmap.md`](../../../95-delivery/delivery-roadmap.md) | Orienting on the overall path (epics E1–E9 map to demos 0–9) |
| [`95-delivery/stories-index.md`](../../../95-delivery/stories-index.md) | Choosing the next story. Legend: `■ done` `▶ in_progress` `□ ready` `· draft` `× blocked` `– dropped`. **Only source of truth for status.** |
| [`95-delivery/demo-cadence.md`](../../../95-delivery/demo-cadence.md) | Story-done and demo-done definitions |
| [`95-delivery/hitl-touchpoints.md`](../../../95-delivery/hitl-touchpoints.md) | **Before any risky action.** |
| [`95-delivery/commit-story-linkage.md`](../../../95-delivery/commit-story-linkage.md) | Commit message shape |
| [`95-delivery/impact-analysis.md`](../../../95-delivery/impact-analysis.md) | Mid-flight scope change |
| [`95-delivery/story-template.md`](../../../95-delivery/story-template.md) | Writing a new story |

Story files live in `95-delivery/stories/story-rcab-eX-sY-<slug>.md`. Their frontmatter carries `status`, `epic`,
`hitl`, `affected_notes`, `depends_on`. `affected_notes` are updated in the same PR as the code.

## 3. The loop (skills in `.claude/skills/`)

```
/pickup-story RCAB-Ex.Sy  ->  /new-branch RCAB-Ex.Sy  ->  implement + test  ->  /close-story  ->  /ship-story [--merge]
```

| Step | Skill | What it does |
|---|---|---|
| Orient | `/pickup-story [id]` | Resolves the story (default: first `□ ready` in the current epic), loads the minimum context at depth 2, states the acceptance criteria back, **asks before proceeding if `hitl: yes`**, then flips status to `in_progress` |
| Branch | `/new-branch id` | Creates `feat/rcab-eX-sY-<slug>` (lowercase, hyphenated) from `origin/main`; warns loudly if you are on another story's branch with uncommitted work |
| Build | — | Smoke the stack first (`/smoke-check`), write the failing test, implement, update `affected_notes` |
| Prove | `/close-story id` | Runs **`pnpm verify`** (lint + policy doc drift + api coverage floor + Testcontainers integration), checks dangling `[[wikilinks]]`, flips status to `done` in three files, drafts the commit and shows the staged diff for sign-off |
| Ship | `/ship-story id [--merge]` | Verify, links check, flip status, commit, push, open PR, optionally `--admin` merge. Its own script lists `pnpm test/lint/build`; `pnpm verify` is the stricter gate named in `CLAUDE.md`, so run it yourself first |
| Merge | `/merge-pr [n]` | Safe merge with conflict handling and local cleanup |
| Watch | `/babysit-prs` | Poll open PRs for CI status (`/loop 5m /babysit-prs`) |
| New work | `/gen-story id slug` | Generates a story file from the template and adds it to the index and the epic |
| Status | `/flip-status id in_progress` or `done` | The atomic three-file flip (story file, `stories-index.md`, epic note) |

At most **one story in flight per epic**. A story is done when every acceptance criterion has a passing test, every
`affected_notes` note reflects the implementation, all commits carry the `Story:` trailer, and `turbo build` +
`turbo test` are green from a clean checkout (full definition in `demo-cadence.md`).

## 4. Commit convention (enforced by a hook)

```
<type>(<scope>): <subject>

<body: what and why>

Story: RCAB-Ex.Sy
Sign-off: <name>        # only when a demo or HITL stop signs off
```

`type` in `feat fix docs refactor test chore perf`; `scope` in `vault api web driver-app infra shared ci` or omit.

The PreToolUse hook `.claude/hooks/check-story-trailer.sh` blocks a `git commit` whose message has no
`Story: RCAB-E<n>.S<m>` trailer **and** whose staged paths include anything outside the vault folders — note that
`docs/`, `apps/`, `infra/`, `scripts/`, `packages/` and the repo root all count as non-vault. Vault-only commits may
omit it. The escape hatch is prefixing the command with `SKIP_STORY_TRAILER=1`, to be used only for commits that
genuinely belong to no story (fixups). Two PostToolUse hooks run on every edit: `mark-codegraph-stale.sh` (drops
`codegraph/.stale` when code changes; then run `pnpm code:graph`) and `validate-vault-links.sh` (warns on dangling
`[[wikilinks]]`).

Practical tip when several people (or agents) share one checkout: stage only your own paths
(`git add <paths>`, never `-A`) and commit with explicit paths so someone else's staged files are not swept in.

## 5. HITL (human-in-the-loop) stops

Full list: [`hitl-touchpoints.md`](../../../95-delivery/hitl-touchpoints.md). Stop and get a human decision before:

- installing a system-level package, or switching corepack versions;
- creating, superseding or revising an **ADR** (`99-decisions/`);
- **deploying to a real VPS** (any demo >= 7);
- touching **secrets handling** or `80-infrastructure/secrets-management.md`;
- adding an external service with cost or vendor lock-in;
- bumping a demo's headline, or reordering/splitting epics;
- a test going flaky enough to consider quarantining it;
- changing a story's **acceptance criteria** mid-flight (run [`impact-analysis`](../../../95-delivery/impact-analysis.md));
- walking any **demo for sign-off** (the merging commit then carries `Sign-off: <name>`).

Phase-0 scope guard: single VPS, single docker-compose (ADR-0009). If a story tempts you toward multi-host,
Kubernetes or managed-cloud services, stop and flag it as an impact-analysis trigger.

Do **not** stop for routine refactors, vault edits that do not touch ADRs/decisions/stories, adding tests, fixing
failing tests with an obvious cause, or lockfile-covered minor/patch bumps.

## 6. Demo sign-off

An epic ends at a demo: run it from a fresh `docker compose up` on a real machine/device, exercise the user flow,
look at the demo's Grafana panels, then record "Demo N signed off" in the PR. Hand-run scripts:
[`docs/manual-testing/RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md) and `demo-walkthrough.md`. At the time of
writing E1–E6 are code-complete and E6's Demo-5 sign-off walk is still owed; E8 (production hardening) stories are
in flight; E7 (rating aggregation and dashboards) and E9 (pilot) follow. Check the index, not this sentence.

## 7. Where to find "what is the current story?"

Open `95-delivery/stories-index.md`: the first `▶` row is work in flight, then the first `□ ready` row. The
"current project state" paragraph in `CLAUDE.md` goes stale — always trust the index.
