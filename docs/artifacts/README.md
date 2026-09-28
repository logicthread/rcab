# docs/artifacts — published artifact record

Local copies of every Claude Artifact published for this project. The file here is the
source of record; the hosted page is a rendering of it.

Rules:

- One `.html` file per artifact. Keep the filename stable — republishing the **same file
  path** updates the same URL. A new filename claims a new URL.
- Record the URL and publish date in the table below when you publish.
- These pages are **snapshots**, not sources of truth. Story status lives in
  `95-delivery/stories-index.md`; architecture lives in `docs/ARCHITECTURE.md` and the
  vault. When the underlying facts move, edit the source note first, then regenerate the
  artifact from it.
- Artifacts are private to the publisher until shared from the page's share menu.

| File | Artifact URL | First published | Purpose |
|---|---|---|---|
| `rcab-demo-runbook.html` | https://claude.ai/artifact/LAkZdQ7BRF6XnjSDbrRuDn | 2026-09-29 | Onboarding + QA baseline: bring-up, hand-walk steps for Demos 0–5, automated suites, system reference, known gaps. Compiled at `main @ 7d5e2cc`. |

## Regenerating the runbook

Its inputs, in order of authority:

1. `docs/manual-testing/RUN-GUIDE.md` — bring-up and per-demo walk steps
2. `docs/ARCHITECTURE.md` — ports, routes, schema, Redis keyspaces, state machine
3. `docs/manual-testing/findings-*.md` — what a real walk turned up, and open follow-ups
4. `95-delivery/delivery-roadmap.md` + `95-delivery/stories-index.md` — demo list and status

After a demo walk, write a dated `docs/manual-testing/findings-<date>.md` first, then fold
the outcome into the runbook's status board and re-publish.
