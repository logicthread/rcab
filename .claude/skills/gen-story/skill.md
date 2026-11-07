---
name: gen-story
description: Generate a new story file from the vault template, add it to stories-index.md and the epic note. Args: RCAB-Ex.Sy <slug> [--title="..."].
---

# gen-story

Automates the 5-step "how to add a new story" process from the bottom of `95-delivery/stories-index.md`.

## Inputs

- `$1` (required): story ID like `RCAB-E4.S3`.
- `$2` (required): slug like `dispatch-geo-candidates` (kebab-case, no prefix).
- `--title="..."` (optional): human-readable title. If omitted, derived from slug.

## Steps

1. **Validate the ID.** Parse epic number and story number from `$1`. Verify:
   - The epic exists in `95-delivery/stories-index.md`.
   - The story number is the next free `S<m>` for that epic (no gaps, no collisions).
   If a collision exists, refuse and show the existing story.

2. **Read the story template.**
   ```bash
   cat 95-delivery/story-template.md
   ```

3. **Generate the story file.** Create `95-delivery/stories/story-rcab-eX-sY-<slug>.md` from the template, filling in:
   - `title:` from `--title` or slug
   - `epic:` link to the epic note
   - `status: draft` (new stories start as draft, not ready)
   - `story_id:` from `$1`
   - Placeholder sections for AC, test plan, affected notes

4. **Add the row to `stories-index.md`.** Append to the correct epic's table:
   ```
   | RCAB-Ex.Sy | [[story-rcab-eX-sY-<slug>]] — <title> | · |
   ```
   The `·` symbol means `draft`.

5. **Add the row to the epic note** (`95-delivery/epic-eN-*.md`):
   Same format as the stories index row.

6. **Report.**
   ```
   Created: 95-delivery/stories/story-rcab-eX-sY-<slug>.md
   Added to: stories-index.md (E<x> table)
   Added to: epic-eN-<name>.md
   Status: draft (promote to ready after review)
   ```

7. **Suggest next steps.** Tell the user to fill in the AC, affected_notes, depends_on, then change status to `ready` when reviewed.

## When to use

- Mid-flight discovery during another story (split-off work)
- Retro follow-ups
- New feature requests

## Anti-patterns

- Don't create a story with `status: ready` — all new stories start as `draft` until reviewed.
- Don't reuse a story number that was dropped (`–`) — append the next free number.
