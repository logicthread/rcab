---
name: new-branch
description: Create a properly named feature branch from up-to-date main for an rcab story. Prevents committing on the wrong branch. Args: RCAB-Ex.Sy.
---

# new-branch

Creates a clean feature branch from the latest `origin/main` for a story. Prevents the "committed on wrong branch" mistake.

## Inputs

- `$1` (required): story ID like `RCAB-E1.S3`.

## Steps

1. **Resolve the story slug.** Find the story file to extract a short slug:
   ```bash
   find 95-delivery/stories -name "*$(echo $1 | tr '.' '-' | tr 'A-Z' 'a-z')*"
   ```
   Extract the slug after the story ID prefix (e.g., `story-rcab-e1-s3-docker-test` → `docker-test`).

2. **Check for uncommitted changes.** Run `git status --porcelain`. If there are unstaged or staged changes, warn the user and ask whether to stash or abort.

3. **Fetch latest main.**
   ```bash
   git fetch origin main
   ```

4. **Create the branch from origin/main.**
   ```bash
   git checkout -b feat/rcab-eX-sY-<slug> origin/main
   ```
   Branch naming convention: `feat/rcab-e1-s3-docker-test` (lowercase, hyphens).

5. **Confirm.**
   ```
   Created branch: feat/rcab-e1-s3-docker-test (from origin/main @ <short-sha>)
   ```

## Guard rails

- If a branch with the same name already exists locally, ask the user:
  - Switch to it (`git checkout <branch>`)
  - Delete and recreate (`git branch -D <branch>` then create fresh)
  - Abort
- If the user is already on a feature branch for a different story with uncommitted work, warn loudly before switching.

## Anti-patterns

- Don't create the branch from a stale local `main` — always fetch first.
- Don't create the branch from another feature branch (leads to merge conflicts in vault index files).
