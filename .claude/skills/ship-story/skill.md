---
name: ship-story
description: Post-implementation lifecycle for an rcab story. Verifies green CI, checks vault links, flips status to done, commits, pushes, opens PR, optionally merges. Args: RCAB-Ex.Sy [--merge].
---

# ship-story

Automates everything after implementation is complete: verification, vault status flip, commit, push, PR creation, and optional merge. Replaces the ~15 manual steps done after every story.

## Inputs

- `$1` (required): story ID like `RCAB-E1.S3`.
- `--merge` (optional): if present, merge the PR with `--admin` after creation.

## Steps

1. **Parse args.** Extract story ID and `--merge` flag.

2. **Verify the story is `in_progress`.** Read `95-delivery/stories/story-rcab-eX-sY-*.md`; frontmatter `status:` must be `in_progress`. If `done`, refuse. If `ready`, warn that it was never picked up.

3. **Run the full CI check.** Stop on first failure:
   ```bash
   pnpm test
   pnpm lint
   pnpm build
   ```

4. **Check for dangling vault links.** For every file changed on this branch (`git diff --name-only main`), extract `[[wiki-links]]` and verify each slug resolves to a `.md` file. Report any dangling links and stop if found.

5. **Flip status to `done`** using the encoding hazard protocol:
   - Read → Edit → `grep -n` verify for each of the 3 files:
     - Story file: `status: in_progress` → `status: done`
     - `95-delivery/stories-index.md`: `▶` → `■` in the matching row
     - Epic note (`95-delivery/epic-eN-*.md`): `▶` → `■` in the matching row
   - If Edit fails with "String not found", inspect raw bytes with `sed -n '<line>p' <file> | xxd | head` to diagnose encoding mismatch.

6. **Commit vault changes.**
   ```bash
   git add 95-delivery/stories/story-rcab-*.md 95-delivery/stories-index.md 95-delivery/epic-*.md
   # Include any other modified vault notes from affected_notes
   SKIP_STORY_TRAILER=1 git commit -m "$(cat <<'EOF'
   docs(vault): RCAB-Ex.Sy — flip status to done

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
   EOF
   )"
   ```

7. **Push the branch.**
   ```bash
   git push -u origin <current-branch>
   ```

8. **Create the PR.** Auto-generate the summary:
   - Title: first non-vault commit's subject line, or `feat(...): RCAB-Ex.Sy — <story title>`
   - Body: commits from `git log --oneline main..HEAD`, diff stat from `git diff --stat main...HEAD`
   - Format per repo convention (Summary bullets + Test plan checklist)
   ```bash
   gh pr create --base main --head <branch> --title "..." --body "..."
   ```

9. **Optionally merge.** If `--merge` was passed:
   - `gh pr merge <number> --merge --admin`
   - If merge conflicts: `git fetch origin main && git rebase origin/main`, resolve conflicts in vault index files (keep both stories' statuses), `git push -f`, retry merge
   - After merge: `git checkout main && git pull origin main`
   - Clean up: report the local feature branch can be deleted

10. **Report receipt.**
    - PR URL
    - Commits included
    - Whether merged or awaiting review
    - Next ready story in the same epic (if any)

## Encoding hazard protocol

Vault files contain special Unicode: `—` (em-dash U+2014), `▶` (U+25B6), `■` (U+25A0), `□` (U+25A1). The Edit tool can silently corrupt these. Always:
1. Read the file first
2. Copy the exact string from the Read output into old_string
3. After Edit, verify with `grep -n '<pattern>' <file>`
4. If Edit fails, use `sed -n '<line>p' <file> | xxd | head` to inspect raw bytes

## Anti-patterns

- Don't ship with failing tests.
- Don't `git add -A` — stage files explicitly.
- Don't skip the dangling-link check.
- Don't force-push to main.
- Don't merge without pushing first (the PR needs the latest commits).
