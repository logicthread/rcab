---
name: playwright-run
description: Run Playwright e2e tests with options for headed mode, specific specs, and video recording. Args: [spec-file] [--headed] [--video].
---

# playwright-run

Runs Playwright e2e tests for the web app. Supports headed mode for debugging and video recording for HITL demo sign-off.

## Inputs

- `$1` (optional): specific spec file or pattern. If omitted, runs all specs.
- `--headed` (optional): run in headed browser mode (visible UI).
- `--video` (optional): record video of the test run.

## Steps

1. **Check the dev stack is running.** The web app and API must be up:
   ```bash
   curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/v1/health/ready
   curl -s -o /dev/null -w '%{http_code}' http://localhost:3002 2>/dev/null || echo "web not up on 3002 — run pnpm dev:up"
   ```

2. **Install Playwright browsers** (if needed):
   ```bash
   cd apps/web && npx playwright install --with-deps chromium
   ```

3. **Build the command.**
   ```bash
   cd apps/web && npx playwright test \
     ${1:+$1} \
     ${headed:+--headed} \
     ${video:+--video on}
   ```

4. **Run the tests.**

5. **Report results.**
   - Total / passed / failed / skipped
   - For failures: spec file, test name, screenshot path
   - If `--video` was used: path to the video file
   - Link to the HTML report:
     ```bash
     npx playwright show-report
     ```

6. **If failures occurred**, show the relevant screenshot and error message for each.

## When to use

- E2e testing for web booking flows (E4+)
- HITL demo walkthroughs with `--headed --video`
- Debugging flaky UI tests
- Before `/ship-story` for any story that touches `apps/web/`

## Anti-patterns

- Don't run Playwright against prod without explicit permission.
- Don't run `--headed` in CI — use headless (the default).
