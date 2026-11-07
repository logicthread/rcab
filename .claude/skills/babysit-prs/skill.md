---
name: babysit-prs
description: Poll open PRs for CI status and report red/green/pending. Use with /loop for continuous monitoring. No args.
---

# babysit-prs

Checks all open PRs in this repo for their CI status and reports a dashboard. Designed to be used with `/loop` for continuous monitoring during active development.

## Inputs

None.

## Steps

1. **List open PRs.**
   ```bash
   gh pr list --state open --json number,title,headRefName,statusCheckRollup,author --limit 20
   ```

2. **For each PR, extract CI status.** Parse `statusCheckRollup` for each PR:
   - `SUCCESS` → green
   - `FAILURE` → red
   - `PENDING` → yellow
   - No checks → gray

3. **Report a dashboard table.**
   ```
   | PR   | Branch                        | Author | CI     | Title                           |
   |------|-------------------------------|--------|--------|---------------------------------|
   | #12  | feat/rcab-e3-s2-firebase-otp  | log    | GREEN  | feat(driver-app): Firebase OTP  |
   | #11  | feat/rcab-e3-s1-flutter-skel  | log    | RED    | feat(driver-app): Flutter skel  |
   | #10  | fix/vault-link-encoding       | log    | PEND   | fix(vault): encoding hazard     |
   ```

4. **If any PR is RED**, show the failed check names:
   ```bash
   gh pr checks <number> --json name,state --jq '.[] | select(.state != "SUCCESS")'
   ```

5. **Suggest actions for red PRs.** For each failing check:
   - If lint failure: suggest running `pnpm lint` locally
   - If test failure: suggest running `pnpm test` locally
   - If build failure: suggest running `pnpm build` locally

## When to use

- `/loop 5m /babysit-prs` — continuous CI monitoring during active development
- After pushing multiple branches and waiting for CI
- Before merging to verify CI is green

## Anti-patterns

- Don't use this as a replacement for reading CI logs — it shows status, not details.
- Don't run too frequently — GitHub API has rate limits (5000/hr for authenticated).
