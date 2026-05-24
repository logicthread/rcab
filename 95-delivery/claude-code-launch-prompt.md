---
title: Claude Code launch prompt
tags: [layer/delivery]
status: living
phase: 0
depends_on: [[delivery-roadmap]], [[stories-index]], [[demo-cadence]], [[hitl-touchpoints]], [[impact-analysis]], [[commit-story-linkage]]
related: [[HOME]], [[LLM-INSTRUCTIONS]], [[reading-paths]]
audience: llm
---

# Claude Code launch prompt

*The paste-into-Claude-Code prompt that bootstraps a fresh implementation session for rcab. The block between the `==== BEGIN/END ====` markers is the prompt itself — copy from there. Everything outside the markers is notes for the developer.*

## How to use

1. Open a Claude Code session at the **repository root** (`/Users/clickershit/workspace/obsidian/rcab/`).
2. Paste the prompt below (the BEGIN…END block) as your first message.
3. Claude Code will inventory the host, propose the first story to pick up, and wait for your approval before installing anything or starting work.

## Why this is in the vault

The prompt itself is a vault artifact — it can change, and it carries a `Story:` trailer when it does ([[commit-story-linkage]]). If you find yourself wanting to tweak Claude Code's bootstrap behavior, edit this note, then commit `docs(vault): tune claude-code-launch-prompt`.

---

==== BEGIN CLAUDE CODE PROMPT ====

You are working in the **rcab** repository — a Phase-0 ride-hailing app for tier-2/3 Indian cities. The architecture is fully specified in an Obsidian vault that lives at the repo root. Your job is to take the project from the current state to a runnable Demo 0 ("Hello, stack"), then demo by demo through to a pilot rollout — strictly following the discipline encoded in the vault.

## Read these in order before doing anything

1. `00-index/LLM-INSTRUCTIONS.md` — vault navigation rules.
2. `00-index/reading-paths.md` — task → minimum note set mapping.
3. `00-index/HOME.md` — the human map.
4. `95-delivery/delivery-roadmap.md` — the 9-demo path.
5. `95-delivery/demo-cadence.md` — the per-story / per-demo contract.
6. `95-delivery/hitl-touchpoints.md` — where you must stop and ask me.
7. `95-delivery/commit-story-linkage.md` — commit message shape (`Story: RCAB-Ex.Sy` trailer is mandatory).
8. `95-delivery/impact-analysis.md` — what to do when scope shifts.
9. `95-delivery/stories-index.md` — the backlog.

**Do not load every note in the vault.** Use `00-index/reading-paths.md` to pull the minimum set for the story you're working on.

## Order of operations on first start

1. **System probe.** Inventory the host: OS, CPU, RAM, disk, Docker, docker compose, Node ≥ 20, pnpm, git, Flutter (if doing driver-app work later). For anything missing, propose the install command via the platform's native package manager (brew on macOS, apt on Debian/Ubuntu). **Do not install anything without my explicit "yes."** Save the inventory as `system-probe-report.json` in the repo root (gitignored).

2. **Single-VPS, vertical-scaling discipline.** Phase-0 is one Linux box running docker-compose. Optimize every decision for that. If a story tempts you toward multi-host or Kubernetes, flag it as out-of-phase and stop ([[hitl-touchpoints]]).

3. **Pick the next `ready` story.** From `95-delivery/stories-index.md`, pick the lowest-numbered `ready` story in the current epic. State the story ID + acceptance criteria back to me, then begin.

4. **Tracking.** Use your task tools (TodoWrite or equivalent) liberally — one task per acceptance criterion is a fine granularity. Mark in-progress when starting, completed when criteria pass. I want the task list to be the live ledger of your work.

5. **Dockerize everything from day one.** Dev (`infra/docker/docker-compose.dev.yml`), test (`infra/docker/docker-compose.test.yml`), prod (`infra/docker/docker-compose.prod.yml`), CI (via the same Dockerfiles). Read `80-infrastructure/docker-dev-environment.md` and `docker-test-environment.md`. The driver Flutter app is the only thing that stays out of Docker.

6. **Tests are not optional.** Every story's acceptance criteria are tested. Unit + integration via Testcontainers; e2e via Playwright (web) and Flutter `integration_test`; load via k6 in a sidecar container. Read `90-quality/testing-strategy.md`.

7. **Capacity estimation.** Demo 0 includes story `RCAB-E1.S9` — the `pnpm system:probe` command that runs k6 on the dev stack and reports the host's user-handling envelope. Use this to validate / sanity-check the Phase-0 VPS sizing in `80-infrastructure/vps-topology.md` before any production-bound work.

8. **Commits.** Conventional Commits + `Story: RCAB-Ex.Sy` trailer. One topic per commit. Read `95-delivery/commit-story-linkage.md`. Never bundle unrelated changes.

9. **HITL stops.** Pause and ask me before: any package install, any ADR creation/change, any deploy to a real VPS, any change to secrets handling, any new external dependency with cost implications, any demo walk-through. Full list in `95-delivery/hitl-touchpoints.md`.

10. **Vault first.** If a story reveals something the architecture vault doesn't capture, **update the vault in the same PR** as the code. Code without vault updates is incomplete work.

11. **Impact analysis.** If a story's acceptance criteria need to change mid-flight, or a new story conflicts with existing notes, follow the 6-question process in `95-delivery/impact-analysis.md` before changing code. Output is a sequence of explicitly-ordered commits, each independently revertable.

12. **What to NOT do**:
    - Don't read the whole vault.
    - Don't write code before the relevant vault notes exist.
    - Don't skip tests "for now."
    - Don't mock infrastructure dependencies in integration tests — use real containers.
    - Don't add a new external service without an ADR.

## What to do right now, in this order

1. Read the 9 files listed above.
2. Run a system inventory (without installs) and report it.
3. Identify the highest-priority `ready` story in the current epic.
4. State the story ID, the acceptance criteria, the test plan, and the affected vault notes.
5. Ask me: "Pick up `RCAB-Ex.Sy`?"
6. Wait for my "yes."

Then proceed by the demo-cadence loop, demo by demo, until a story marked `RCAB-E9.S4 Scale-out checklist to Phase-0 targets` is `done`.

The vault is the contract. The roadmap is the path. The stories are the unit. Demos are the waypoints. Commits are the receipts.

==== END CLAUDE CODE PROMPT ====

---

## Notes for the developer (not part of the prompt)

- The prompt is intentionally **strict** about HITL stops. If you find Claude Code asking too often for things you'd rather it just does, edit the "HITL stops" line in this file (and in `95-delivery/hitl-touchpoints.md`), commit, and re-paste the prompt.
- If you spin up a sub-agent inside Claude Code (e.g., a specialized review agent), give it the same vault read-order in its first message.
- The prompt assumes Claude Code is operating with shell + filesystem access. If you've restricted tools, adjust accordingly.

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[hitl-touchpoints]] · [[impact-analysis]] · [[commit-story-linkage]]
- [[LLM-INSTRUCTIONS]] · [[reading-paths]] · [[HOME]]
