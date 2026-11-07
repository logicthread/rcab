---
name: flutter-test
description: Run Flutter tests for the driver app (unit, widget, or integration). Lives outside the pnpm workspace so needs its own skill. Args: [unit|widget|integration|all] [--file=<path>].
---

# flutter-test

Runs Flutter tests for `apps/driver-app/`. The driver app is outside the pnpm workspace (Dart/Flutter, not Node), so `pnpm test` does not cover it.

## Inputs

- `$1` (optional): test type — `unit` (default), `widget`, `integration`, or `all`.
- `--file=<path>` (optional): run a specific test file relative to `apps/driver-app/`.

## Steps

1. **Check Flutter is available.**
   ```bash
   flutter --version
   ```
   If missing, stop and tell the user to install Flutter SDK.

2. **Ensure dependencies are up to date.**
   ```bash
   cd apps/driver-app && flutter pub get
   ```

3. **Run code generation** (freezed + json_serializable models must be current):
   ```bash
   cd apps/driver-app && dart run build_runner build --delete-conflicting-outputs
   ```

4. **Run the requested tests.**

   - `unit` (default):
     ```bash
     cd apps/driver-app && flutter test test/
     ```
   - `widget`:
     ```bash
     cd apps/driver-app && flutter test test/ --tags widget
     ```
   - `integration`:
     ```bash
     cd apps/driver-app && flutter test integration_test/ --timeout 120s
     ```
     Integration tests require a running emulator or device. If none found, report and stop.
   - `all`: run unit then integration sequentially.
   - `--file=<path>`:
     ```bash
     cd apps/driver-app && flutter test <path>
     ```

5. **Report results.** Parse the test runner output and report:
   - Total / passed / failed / skipped
   - For failures: file, test name, assertion message

## When to use

- After any change in `apps/driver-app/lib/` or `apps/driver-app/test/`
- During `/close-story` or `/ship-story` for E3+ stories that touch the driver app
- To verify freezed model codegen didn't break anything

## Anti-patterns

- Don't skip `build_runner` — stale generated code is the #1 cause of phantom test failures in this app.
- Don't run integration tests without a device/emulator — they'll hang.
