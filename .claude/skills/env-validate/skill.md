---
name: env-validate
description: Diff .env files against env.example, report missing and extra keys. Catches "container starts but crashes on missing env var" bugs. No args.
---

# env-validate

Compares `.env.dev` and `.env.prod` (if present) against `infra/docker/env.example` to catch missing or extra environment variables before they cause runtime crashes.

## Inputs

None.

## Steps

1. **Extract keys from env.example** (the canonical list):
   ```bash
   grep -v '^#' infra/docker/env.example | grep '=' | cut -d= -f1 | sort
   ```

2. **Extract keys from .env.dev:**
   ```bash
   grep -v '^#' .env.dev 2>/dev/null | grep '=' | cut -d= -f1 | sort
   ```
   If `.env.dev` doesn't exist, report that `pnpm dev:up` will auto-create it.

3. **Extract keys from .env.prod** (if present):
   ```bash
   grep -v '^#' .env.prod 2>/dev/null | grep '=' | cut -d= -f1 | sort
   ```

4. **Diff each env file against the example.**
   ```bash
   comm -23 <(example_keys) <(env_keys)   # in example but missing from env
   comm -13 <(example_keys) <(env_keys)   # in env but not in example (extras)
   ```

5. **Check for secrets in wrong files.** Warn if any of these patterns appear in tracked files:
   - `FIREBASE_SERVICE_ACCOUNT` with a non-placeholder value
   - `JWT_SECRET` with a non-placeholder value
   - Any key containing `PASSWORD` or `SECRET` with a real-looking value

6. **Report a table per env file.**
   ```
   ## .env.dev
   | Key                    | Status            |
   |------------------------|-------------------|
   | POSTGRES_USER          | OK                |
   | FIREBASE_PROJECT_ID    | MISSING           |
   | LEGACY_DEBUG_FLAG      | EXTRA (not in example) |

   ## .env.prod
   | ... | ... |
   ```

## When to use

- After adding a new env var to any service
- Before `pnpm dev:up` if the stack has been down for a while
- After pulling new changes that might have added env vars
- During `/smoke-check` failures to diagnose missing config
