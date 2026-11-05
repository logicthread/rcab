---
name: merge-pr
description: Safe PR merge flow with conflict resolution, admin bypass, and local cleanup. Args: PR# (or blank → current branch's PR).
---

# merge-pr

Merges a GitHub PR with automatic conflict resolution and local main sync. Encodes the merge dance that handles branch protection (1 required review → admin bypass) and vault index file conflicts.

## Inputs

- `$1` (optional): PR number. If absent, detect from current branch via `gh pr view --json number`.

## Steps

1. **Resolve the PR number.**
   - If `$1` given, use it directly.
   - Otherwise: `gh pr view --json number -q .number` (uses current branch).
   - If no PR found, error and stop.

2. **Check PR status.**
   ```bash
   gh pr view <number> --json mergeable,mergeStateStatus,title,headRefName
   ```
   - If already merged, report and stop.
   - If not mergeable (e.g., conflicts), proceed to step 4 (rebase).
   - If blocked by review only, proceed with `--admin`.

3. **Attempt merge.**
   ```bash
   gh pr merge <number> --merge --admin
   ```
   - If successful, skip to step 5.
   - If fails with "merge conflicts", proceed to step 4.

4. **Resolve conflicts via rebase.**
   ```bash
   git fetch origin main
   git rebase origin/main
   ```
   - **Vault index file conflicts** (`stories-index.md`, `epic-eN-*.md`): These almost always conflict on adjacent status symbol lines. Resolution rule: keep BOTH stories' statuses from their respective sides (HEAD has the merged story as `■`, the branch has its story as `▶` or `■`).
   - After resolving each conflict: `git add <file> && git rebase --continue`
   - After full rebase: `git push -f origin <branch>`
   - Retry: `gh pr merge <number> --merge --admin`

5. **Update local main.**
   ```bash
   git checkout main
   git pull origin main
   ```

6. **Report.**
   ```
   Merged PR #<number>: <title>
   main is at <short-sha>
   Local branch <branch> can be deleted with: git branch -d <branch>
   ```

## Conflict resolution patterns

The most common conflict in this repo is vault index files where two stories' status symbols changed on adjacent lines. The resolution is always the same:

```
# CONFLICT in stories-index.md:
<<<<<<< HEAD
| RCAB-E1.S6 | ... | ■ |    ← merged PR set S6 to done
| RCAB-E1.S7 | ... | □ |    ← HEAD still has S7 as ready
=======
| RCAB-E1.S6 | ... | □ |    ← branch didn't have S6's change
| RCAB-E1.S7 | ... | ▶ |    ← branch set S7 to in_progress
>>>>>>> branch

# Resolution: take the newer status for each story
| RCAB-E1.S6 | ... | ■ |
| RCAB-E1.S7 | ... | ▶ |
```

## Anti-patterns

- Don't force-push to main — only force-push the feature branch after rebase.
- Don't delete the remote branch manually — `gh pr merge` handles it.
- Don't merge without checking status first — the PR might already be merged.
