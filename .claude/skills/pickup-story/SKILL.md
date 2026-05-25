---
name: pickup-story
description: Orient on a ready rcab story per path:work-a-story. Loads minimum vault notes, states acceptance criteria back, asks before any HITL flag, then flips status to in_progress. Args: RCAB-Ex.Sy (or blank → next ready story in current epic).
---

# pickup-story

Encodes `path:work-a-story` from `00-index/reading-paths.md`. Use this BEFORE writing any implementation code for a story.

## Inputs

- `$1` (optional): story ID like `RCAB-E1.S3`. If absent, pick the lowest-numbered story with status `□` (ready) from `95-delivery/stories-index.md`.

## Steps

1. **Resolve the story.** If `$1` was given, read `95-delivery/stories/story-rcab-eX-sY-*.md`. Otherwise scan `95-delivery/stories-index.md` for the first `□` row in the current epic, then resolve its file via the link in the row.

2. **Read the story file.** Extract from frontmatter:
   - `status:` — must be `ready`. If `in_progress`, ask the user whether to resume or pick a different story. If `draft` / `blocked` / `dropped` / `done`, refuse and explain.
   - `epic:` — link to the epic note.
   - `hitl:` — if `yes`, treat as a hard stop after step 4 (do NOT flip status until user confirms).
   - `affected_notes:` — list of vault links.
   - `depends_on:` — list of vault links.

3. **Load the minimum context (depth 2).** Read every note in `affected_notes` and `depends_on`. For each, follow its frontmatter `depends_on:` once more (one transitive hop). Stop. Do not read the whole vault.

4. **State the contract back to the user**, in this exact shape:

   ```
   ## RCAB-Ex.Sy — <title>

   **Acceptance criteria:**
   - <user-facing AC bullets verbatim>
   - <technical AC bullets verbatim>

   **Test plan:** <one line>

   **Affected vault notes (will be updated in the same PR):**
   <bulleted list>

   **HITL flags:** <none | list any matched against 95-delivery/hitl-touchpoints.md>

   **Judgment calls I'll make** (flag if user wants different):
   <bulleted list of choices not pinned by vault>
   ```

5. **Stop and ask** if any HITL flag matched, OR if frontmatter `hitl: yes`, OR if a judgment call has non-trivial reversibility cost. Wait for explicit "yes, pick it up".

6. **Flip status to `in_progress`** in three files (only after confirmation):
   - The story file: frontmatter `status: in_progress`.
   - `95-delivery/stories-index.md`: change `□` → `▶` in the matching row.
   - The epic note (`95-delivery/epic-eN-*.md`): same symbol change in its Stories table.

7. **Create a task list** with one task per acceptance criterion (use TaskCreate). Mark the first task `in_progress`.

8. **Begin implementation.** Follow the demo-cadence loop in `95-delivery/demo-cadence.md`. After any `pnpm install` that adds packages with native build scripts, run
   `pnpm approve-builds` to enable native compilation (testcontainers deps: cpu-features,
   protobufjs, ssh2).

## Out of scope for this skill

- Writing code. That's the next step after orientation.
- Marking the story `done`. Use `/close-story` for that.
- Adding a new story. Use `/add-new-story` (TBD) or follow `path:add-new-story` manually.

## Anti-patterns

- Don't read the entire vault. Reading-paths exist for a reason.
- Don't skip the HITL check. `hitl-touchpoints.md` is the contract.
- Don't flip status before stating the contract back and getting confirmation.
- Don't pick a `draft` story and try to "promote" it — that's a separate review.
