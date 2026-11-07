---
name: security-scan
description: Run npm audit + secret scan + OWASP pattern check across the workspace. Maps findings against the vault security checklist. No args.
---

# security-scan

Automated security scan that maps results against the vault's `90-quality/security-checklist.md`. Complements the built-in `/security-review` (which reviews diffs) by scanning the full codebase for known vulnerabilities and bad patterns.

## Inputs

None.

## Steps

1. **npm audit across workspace packages.**
   ```bash
   pnpm audit --audit-level=moderate 2>&1 || true
   ```
   Parse and report: total vulnerabilities by severity (critical, high, moderate).

2. **Check for hardcoded secrets.** Scan for patterns that should never appear in committed code:
   ```bash
   grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.yaml' --include='*.yml' \
     -E '(FIREBASE_SERVICE_ACCOUNT|JWT_SECRET|POSTGRES_PASSWORD|REDIS_PASSWORD)\s*[:=]\s*["\x27][^"\x27]{8,}' \
     apps/ packages/ infra/ 2>/dev/null | grep -v node_modules | grep -v '.env.example'
   ```

3. **Check for exposed env vars in Next.js bundles.** Any `NEXT_PUBLIC_` prefixed var is client-visible:
   ```bash
   grep -rn 'NEXT_PUBLIC_' apps/web/src/ 2>/dev/null
   ```
   Flag any that contain SECRET, PASSWORD, KEY (except public API keys that are meant to be client-side, like Firebase config).

4. **Check for common OWASP patterns.**
   - SQL injection: raw SQL without parameterization
     ```bash
     grep -rn --include='*.ts' 'sql`.*\${' apps/api/src/ 2>/dev/null
     ```
   - XSS: `dangerouslySetInnerHTML` without sanitization
     ```bash
     grep -rn 'dangerouslySetInnerHTML' apps/web/src/ 2>/dev/null
     ```
   - Open redirects: unvalidated redirect URLs
     ```bash
     grep -rn --include='*.ts' 'res.redirect.*req\.' apps/api/src/ 2>/dev/null
     ```

5. **Check dependency versions for known CVEs.** Look for pinned versions with known issues:
   ```bash
   pnpm outdated --recursive 2>&1 | head -40
   ```

6. **Load and cross-reference the security checklist** (`90-quality/security-checklist.md`). For each checklist item, report whether this scan can verify it and what the result is.

7. **Report a summary.**
   ```
   ## Security scan results
   
   | Category              | Findings | Severity |
   |-----------------------|----------|----------|
   | npm audit             | 2        | moderate |
   | Hardcoded secrets     | 0        | —        |
   | Exposed env vars      | 1        | low      |
   | OWASP patterns        | 0        | —        |
   | Outdated deps (major) | 3        | info     |
   
   **Action items:**
   - [ ] Review NEXT_PUBLIC_FIREBASE_API_KEY exposure (expected, but verify)
   - [ ] Update express from 4.18 → 4.21 (CVE-xxx)
   ```

## When to use

- E8.S4 acceptance criteria (security checklist sweep)
- After adding new dependencies
- Before any demo sign-off
- Periodically as a hygiene check
