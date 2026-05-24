---
title: Story template
tags: [layer/delivery]
status: living
phase: both
depends_on: [[story-id-scheme]]
related: [[stories-index]], [[commit-story-linkage]], [[hitl-touchpoints]]
audience: both
---

# Story template

*Every story file uses this shape. Copy it; fill in.*

## Frontmatter

```yaml
---
title: RCAB-Ex.Sy — short subject in imperative form
tags: [layer/delivery, kind/story]
status: draft | ready | in_progress | in_review | done | blocked | dropped
phase: 0 | 1
epic: [[epic-ex-name]]
demo: <n>                 # which roadmap demo this contributes to
estimate: xs | s | m | l  # gut feel; not for scheduling
hitl: yes | no            # does completion require dev sign-off
depends_on: [[other-story]], [[any-vault-note]]
blocks: [[other-story]]
affected_notes: [[vault-note-1]], [[vault-note-2]]
owner: claude | dev | both
audience: both
---
```

## Body (in order)

1. **Goal** — one paragraph. *Why* we are doing this in plain language.
2. **User-facing acceptance criteria** — Gherkin-ish bullets:
   - `Given …, When …, Then …`
   - Each criterion is independently testable.
3. **Technical acceptance criteria** — internal checks (e.g., "Redis key `active_drivers` exists for online drivers", "endpoint returns 200 with the contract from [[rest-endpoints]]").
4. **Test plan** — explicit list of tests to add:
   - Unit: …
   - Integration: …
   - E2E (if applicable): …
   - Load (if applicable): …
5. **HITL stops** — *only* if `hitl: yes`. List the moments the developer must look.
6. **Out of scope** — what we are explicitly *not* doing in this story.
7. **Notes / questions** — open items the implementer should flag during work.
8. **See also** — links: the epic, sibling stories, every affected vault note.

## Status workflow

```
draft       → just written, may change
ready       → reviewed; safe to pick up
in_progress → assigned & started
in_review   → PR open / demo runnable but not signed off
done        → demo signed off, PR merged
blocked     → cannot proceed; needs decision (see [[impact-analysis]])
dropped     → no longer relevant (kept for history; never deleted)
```

## Rules

- A story exists in the vault **before** code begins for it.
- Acceptance criteria are written once; they're the contract. If they change mid-flight, run [[impact-analysis]].
- A story is `done` only when **all** of: tests green, demo walked, sign-off recorded in the PR description, vault notes updated to reflect what we built.
- Commit messages reference the story ID — see [[commit-story-linkage]].

## See also
- [[story-id-scheme]] · [[stories-index]]
- [[commit-story-linkage]] · [[hitl-touchpoints]] · [[impact-analysis]]
- [[delivery-roadmap]]
