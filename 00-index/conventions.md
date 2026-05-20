---
title: Vault conventions
tags: [moc, llm, navigation]
status: living
audience: both
---

# Conventions

How notes are written, named, and linked. Read this before adding a note.

## Filenames & slugs

- Files are kebab-case `.md`.
- Each filename (without extension) is a globally unique **slug**. `[[wiki-link]]` targets use the slug — never a path.
- Slug prefixes encode kind for readability when scanning:
  - `entity-*`, `module-*`, `journey-*`, `features-*`, `sm-*` (state machine), `algo-*`, `integration-*`, `web-*`, `driver-*`, `ADR-NNNN-*`, `phase-*`

## Folders

| Folder | Purpose |
|---|---|
| `00-index/` | MOCs, glossary, conventions, LLM instructions, reading paths |
| `10-product/` | Vision, personas, features, journeys, phasing |
| `20-architecture/` | System overview, C4, deployment, tech stack |
| `30-domain/` | Entities, data model, state machines |
| `40-backend/` | NestJS modules, API, persistence, realtime |
| `50-clients/` | Web + Flutter |
| `60-integrations/` | Third-party services |
| `70-algorithms/` | Standalone algorithm notes |
| `80-infrastructure/` | VPS, ops, deploy |
| `90-quality/` | Testing, security, performance |
| `99-decisions/` | ADRs |

The folder is **navigation aid only**. Slug uniqueness means files can be re-organized without breaking links.

## Frontmatter

```yaml
---
title: Human-readable title
tags: [layer/..., kind/...]
status: draft | proposed | accepted | deprecated | living
phase: 0 | 1 | both
depends_on: [[slug-1]], [[slug-2]]
related: [[slug-3]]
audience: human | llm | both
---
```

- `depends_on` is the LLM's instruction: "to understand this note, load these first."
- `related` is editorial — useful but optional reading.

## Tag taxonomy

Two facets. Pick one from each.

Layer: `layer/product`, `layer/architecture`, `layer/domain`, `layer/backend`, `layer/client-web`, `layer/client-driver`, `layer/integration`, `layer/algorithm`, `layer/infra`, `layer/quality`, `layer/decision`

Kind: `kind/moc`, `kind/persona`, `kind/journey`, `kind/feature`, `kind/entity`, `kind/state-machine`, `kind/module`, `kind/api`, `kind/diagram`, `kind/adr`, `kind/runbook`, `kind/algo`, `kind/integration`

## Note structure

1. **Frontmatter** (above).
2. **One-line summary** in italics directly below the H1.
3. **Body** — concise; one note = one idea.
4. **Diagrams** in mermaid where helpful.
5. **`## See also`** at the bottom with 3–8 wiki-links.

## Mermaid

Obsidian renders mermaid natively. Prefer it over text diagrams. Common diagrams in this vault:

- `flowchart` — flows of control
- `sequenceDiagram` — request/response over time
- `stateDiagram-v2` — state machines
- `erDiagram` — entity relationships
- `C4Context` / `C4Container` — architecture diagrams

## ADRs

We use a compact MADR variant. See [[adr-template]].

- Number monotonically: `ADR-NNNN-short-title.md`.
- Never delete an accepted ADR. Mark `status: deprecated` and link the superseding ADR.
- Every locked architectural decision must have an ADR or it didn't happen.

## See also
- [[HOME]] · [[LLM-INSTRUCTIONS]] · [[reading-paths]] · [[glossary]]
- [[adr-template]]
