# Development workflows

One file per workflow. Read them in this order on your first week; later they are lookup pages.

| # | Workflow | File | You need it when |
|---|---|---|---|
| 1 | Local setup | [local-setup.md](local-setup.md) | First day: get the stack, the web app and the driver app running |
| 2 | Story lifecycle | [story-lifecycle.md](story-lifecycle.md) | Before you write any code: how work is picked, tracked, committed and signed off |
| 3 | Testing | [testing.md](testing.md) | Writing or running tests; understanding the `pnpm verify` gate |
| 4 | Database migrations | [database-migrations.md](database-migrations.md) | Any schema change; any `migration_conflict` row |
| 5 | Business-config changes | [business-config-changes.md](business-config-changes.md) | Changing a fare, timer, threshold or cancel rule |
| 6 | Adding a feature end to end | [adding-a-feature-end-to-end.md](adding-a-feature-end-to-end.md) | A worked example across api + web + driver app |
| 7 | Debugging and tooling | [debugging-and-tooling.md](debugging-and-tooling.md) | Something is wrong on your machine or in the dev stack |
| 8 | Release and deploy | [release-and-deploy.md](release-and-deploy.md) | Shipping an image to the VPS; rolling back |
| 9 | Incident and recovery | [incident-and-recovery.md](incident-and-recovery.md) | Production is unhealthy; data loss; restore drills |
| 10 | Code review and quality | [code-review-and-quality.md](code-review-and-quality.md) | Opening or reviewing a PR; lint and security checks |

Companion documents: [state machines](../state-machines.md) (every lifecycle in the system, with the code that
enforces it), [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md), [`docs/POLICY.md`](../../POLICY.md),
[`docs/manual-testing/RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md), the repo-root
[`CLAUDE.md`](../../../CLAUDE.md) (session contract for AI-assisted work) and the vault map
[`00-index/HOME.md`](../../../00-index/HOME.md).

Conventions used in these pages: commands run from the repo root unless stated; `DC` stands for
`docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml`; "the vault" is the numbered folders
(`00-index/` … `99-decisions/`) which are Obsidian notes, not code.
