---
name: flip-status
description: Atomic 3-file vault status flip for an rcab story. Handles encoding hazards with □/▶/■ symbols automatically. Args: RCAB-Ex.Sy <in_progress|done>.
---

# flip-status

Single-purpose skill for the most repeated vault operation: changing a story's status across all 3 tracking files atomically.

## Inputs

- `$1` (required): story ID like `RCAB-E1.S3`.
- `$2` (required): target status — `in_progress` or `done`.

## Predecessor validation

| Target | Required current status | Symbol change |
|---|---|---|
| `in_progress` | `ready` | `□` → `▶` |
| `done` | `in_progress` | `▶` → `■` |

If the current status doesn't match the expected predecessor, refuse and explain. Exception: if `$2` is `in_progress` and current is already `in_progress`, ask the user if they want to resume.

## Steps

1. **Resolve the 3 files:**
   - Story file: `find 95-delivery/stories -name "*<slug>*"` where slug is derived from the story ID (e.g., `e1-s3`)
   - Stories index: `95-delivery/stories-index.md`
   - Epic note: extract `epic:` from story frontmatter, resolve to `95-delivery/epic-eN-*.md`

2. **Read all 3 files.** Extract the current status from each. Verify they agree. If they disagree, report the inconsistency and stop.

3. **Edit each file** using the encoding hazard protocol:
   - **Story file**: change frontmatter `status: <current>` → `status: <target>`
   - **Stories index**: change the status symbol in the row matching the story ID
   - **Epic note**: change the status symbol in the row matching the story ID
   - After each Edit, verify with `grep -n` that the change took effect

4. **Commit.**
   ```bash
   git add <3 files>
   SKIP_STORY_TRAILER=1 git commit -m "$(cat <<'EOF'
   docs(vault): RCAB-Ex.Sy — flip status to <target>

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
   EOF
   )"
   ```

## Encoding hazard protocol

The `□`, `▶`, `■` symbols and `—` (em-dash) can be silently corrupted by the Edit tool. For each edit:
1. Read the file to get the exact bytes in context
2. Copy the exact matching string from Read output into `old_string`
3. After Edit succeeds, run `grep -n '<symbol>' <file>` to confirm
4. If Edit fails with "String not found", diagnose with:
   ```bash
   sed -n '<line>p' <file> | xxd | head
   ```
   Then retry with the correct byte sequence.

## Anti-patterns

- Don't edit only 1 or 2 of the 3 files — all 3 must stay in sync.
- Don't skip the grep verification step.
- Don't flip to `done` without running `/close-story` or `/ship-story` first (tests must pass).
