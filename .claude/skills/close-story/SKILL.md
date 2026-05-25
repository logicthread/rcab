---
name: close-story
description: Close out an in-progress rcab story. Verifies tests + builds green, checks for dangling vault links, flips status to done in 3 files, drafts a Conventional Commit with the mandatory Story: trailer, and shows the staged diff for sign-off before committing. Args: RCAB-Ex.Sy.
---

# close-story

The exit gate for a story. Use this when you believe every acceptance criterion has a passing test and the affected vault notes are up to date.

## Inputs

- `$1` (required): story ID like `RCAB-E1.S3`.

## Steps

1. **Sanity-check the story is in_progress.**
   - Read `95-delivery/stories/story-rcab-eX-sY-*.md`; frontmatter `status:` must be `in_progress`. If `done`, refuse — already closed. If anything else, ask before proceeding.

2. **Run the test suite.** Execute (in this order, stop on first failure):
   ```bash
   pnpm lint
   pnpm build
   pnpm test
   ```
   If any fail, stop. Report what failed. Do NOT proceed to status changes.

3. **Run the affected-criteria check.** Re-read the story's acceptance criteria and confirm each has a test (search the test files for behavior matching the criterion's wording). For any AC without a matching test, ask the user before continuing.

4. **Check for dangling vault links.** Across all `[[wiki-links]]` in files this story touched (use `git diff --name-only main`), verify each slug resolves to an actual `.md` in the vault. List any dangling links and ask the user to either fix them or accept stubs.

5. **Flip status to `done`** in three files:
   - The story file: frontmatter `status: done`.
   - `95-delivery/stories-index.md`: `▶` → `■` in the matching row.
   - The epic note: same change in its Stories table.

6. **Stage the changes.** `git status` first; stage explicitly (never `git add -A` / `git add .`). Group commits logically per `95-delivery/commit-story-linkage.md`:
   - One commit per topic. Don't mix a refactor and a feature.
   - Every commit touching non-vault paths gets `Story: RCAB-Ex.Sy` trailer.
   - Vault-only commits may carry the trailer if they directly serve the story (recommended).

7. **Draft the commit message(s).** Use this template:
   ```
   <type>(<scope>): <subject>

   <body — what & why; bulleted if multiple changes>

   Story: RCAB-Ex.Sy
   ```
   Then `git diff --cached` and show the user the staged diff + drafted message.

8. **Stop and wait** for the user's "yes, commit". Do not run `git commit` autonomously.

9. **Commit.** Use HEREDOC for the message body so formatting survives:
   ```bash
   git commit -m "$(cat <<'EOF'
   ...
   Story: RCAB-Ex.Sy
   EOF
   )"
   ```
   The PreToolUse hook (`.claude/hooks/check-story-trailer.sh`) will block if the trailer is missing.

10. **Report receipt.** After commit, output a one-screen receipt:
    - AC table (criterion → result)
    - Commits made (hash + subject)
    - Vault notes updated
    - Any open soft flags
    - The next ready story in the same epic (suggest as next pickup)

## Out of scope

- Walking the demo for sign-off — that's a separate skill (`/verify-demo`, future) + HITL stop.
- Pushing to remote — wait for explicit user instruction.
- Marking the epic done — only when EVERY story in it is `■`.

## Anti-patterns

- Don't mark a story `done` with failing tests.
- Don't bundle unrelated changes into one commit just because they happened in the same session.
- Don't commit without showing the diff first — sign-off is the human contract.
- Don't skip the dangling-link check — silent vault rot compounds across stories.
