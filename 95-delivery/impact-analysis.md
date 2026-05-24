---
title: Impact analysis process
tags: [layer/delivery]
status: accepted
phase: both
depends_on: [[delivery-roadmap]]
related: [[story-template]], [[hitl-touchpoints]], [[commit-story-linkage]]
audience: both
---

# Impact analysis

*When scope changes — a new story arrives mid-flight, an existing story's acceptance criteria shift, an ADR needs to be revisited — we **stop and analyze** before changing anything.*

## When to run an impact analysis

- A new user story is proposed.
- An existing story's acceptance criteria change.
- A bug or learning forces a change to an ADR.
- A demo's headline must change.
- A new external dependency or constraint shows up (vendor outage, legal, cost).
- A performance budget is violated and won't recover without redesign.

## The 6 questions

For every change, the analysis answers these in writing, in the affected story's file (or a fresh `analysis-YYYYMMDD-<slug>.md` in `95-delivery/analyses/`):

1. **What changed?** — one paragraph; the diff in intent.
2. **Why now?** — what triggered it.
3. **Which vault notes are wrong / incomplete because of this?** — list them; update them, link the updates.
4. **Which stories does this touch?** — pull from `affected_notes` and `depends_on` frontmatter; expand to direct + transitive (depth 2).
5. **Which demos are affected?** — does any demo's headline still hold?
6. **Decision** — apply / defer / reject; if apply, list the follow-up stories.

## Output

An impact analysis produces commits in a specific order:

1. `docs(vault): impact-analysis for <reason>` — adds the analysis file.
2. `refactor(vault): update notes touched by <reason>` — applies the note edits.
3. `feat(vault): new stories from <reason>` — adds resulting stories.
4. `chore(vault): mark blocked/dropped stories from <reason>` — adjusts existing stories' status.

Splitting into separate commits is non-negotiable. Each commit must be independently revertable.

## HITL discipline

- A new story being added to an empty epic, with no contradiction in the vault, does **not** require sign-off — write it and move on.
- Any analysis that proposes touching an accepted ADR or a `done` story does require sign-off ([[hitl-touchpoints]]).

## Anti-pattern: "small change" creep

If a story's acceptance criteria edit "feels small" but its `affected_notes` list grows, that's a flag. Either:

- Split into two stories, or
- Bump it back to `draft`, run a full analysis.

The signal is the `affected_notes` count, not the prose length of the edit.

## See also
- [[delivery-roadmap]] · [[story-template]] · [[hitl-touchpoints]]
- [[commit-story-linkage]] · [[conventions]]
