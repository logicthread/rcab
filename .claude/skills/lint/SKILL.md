---
name: lint
description: Run ESLint + TypeScript type-check across the pnpm workspace, and Dart analyzer on the driver app. Report errors, warnings, and type violations in one pass. No args.
---

# lint

Lint and type-check the entire codebase in one command. Catches issues before they reach CI.

## Inputs

None. Pass `--fix` to auto-fix ESLint violations where possible.

## Steps

1. **ESLint across the workspace.**
   ```bash
   pnpm --filter='./apps/*' --filter='./packages/*' exec eslint . --ext .ts,.tsx --max-warnings 0 2>&1
   ```
   If `--fix` was passed, add `--fix` to the eslint command first, then re-run to verify zero warnings remain.

2. **TypeScript type-check (tsc --noEmit).**
   ```bash
   pnpm --filter='./apps/api' tsc --noEmit 2>&1
   pnpm --filter='./apps/web' tsc --noEmit 2>&1
   ```
   Capture exit codes separately.

3. **Dart analyzer on the driver app.**
   ```bash
   cd apps/driver-app && dart analyze --fatal-infos 2>&1 | tail -30
   ```

4. **Prettier format check.**
   ```bash
   pnpm prettier --check "apps/**/*.{ts,tsx}" "packages/**/*.ts" 2>&1 | tail -20
   ```

5. **Print summary table.**
   ```
   | Check            | Status | Issues |
   |------------------|--------|--------|
   | ESLint           | ✓      | 0      |
   | tsc (api)        | ✓      | 0      |
   | tsc (web)        | ✓      | 0      |
   | dart analyze     | ✗      | 3      |
   | prettier         | ✓      | 0      |
   ```
   If any FAIL, print the first 20 lines of errors for that check.

## When to use

- Before `/ship-story` or opening a PR
- After a large refactor
- As a quick sanity check after editing shared packages

## Anti-patterns

- Don't run with `--fix` on a dirty working tree — stage your changes first.
