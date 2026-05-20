---
title: Instructions for LLM contributors
tags: [moc, llm, navigation]
status: living
audience: llm
---

# LLM Instructions — read this first

You are working in the **rcab** vault. Your job is to extend, query, or implement from this knowledge base. Follow these rules.

## 1. Selective context loading is the whole point

Do **not** read every file in the vault. The user has explicitly designed this vault so that any task can be done with the minimum necessary context. Your workflow is:

1. Read this file ([[LLM-INSTRUCTIONS]]).
2. Read [[reading-paths]].
3. Find the reading path that matches the user's task.
4. Load **only** the notes listed in that path, plus any `[[wiki-links]]` those notes flag as `depends_on:` in their frontmatter.
5. Do the work.

If no reading path matches, propose a new one and add it to [[reading-paths]] before working.

## 2. The vault is the source of truth

When the user requests a feature or change:

1. Locate the relevant notes via [[reading-paths]] or [[HOME]].
2. If the change requires architectural decisions that don't yet exist in the vault, **write or update notes first**, including an ADR in `99-decisions/` if the decision is significant.
3. Only after the vault reflects the new state, generate code.

Never invent architecture that contradicts an existing ADR without first proposing a new ADR that supersedes it.

## 3. Frontmatter schema

Every note has YAML frontmatter:

```yaml
---
title: Human-readable title
tags: [layer/domain, kind/state-machine, ...]   # see conventions
status: draft | proposed | accepted | deprecated | living
phase: 0 | 1 | both
depends_on: [[note-1]], [[note-2]]              # required reading to understand this note
related: [[note-3]]                              # nice to have
audience: human | llm | both
---
```

When you load a note, also load every note in its `depends_on:` list (transitively, but stop at depth 2 unless the task demands more).

## 4. Tag taxonomy

Two facets: **layer** and **kind**.

- Layers: `layer/product`, `layer/architecture`, `layer/domain`, `layer/backend`, `layer/client-web`, `layer/client-driver`, `layer/integration`, `layer/algorithm`, `layer/infra`, `layer/quality`, `layer/decision`
- Kinds: `kind/moc`, `kind/persona`, `kind/journey`, `kind/feature`, `kind/entity`, `kind/state-machine`, `kind/module`, `kind/api`, `kind/diagram`, `kind/adr`, `kind/runbook`, `kind/algo`, `kind/integration`

Both `tags:` and folder location should agree.

## 5. Linking rules

- Use `[[wiki-links]]` for any reference to another note. The link target is the **slug** (filename without `.md`), not the title.
- The slug is unique across the vault. We do not rely on Obsidian's folder-aware shortest-path links.
- Each note ends with a `## See also` section linking 3–8 relevant neighbors, so the graph stays well-connected.

## 6. Style

- **Concise.** A note is a single idea. If it grows past ~300 lines, split it.
- **Mermaid for diagrams** — never ASCII art, never SVG. Obsidian renders mermaid natively.
- **Code blocks are illustrative**, not authoritative. The authoritative artifact is text + diagram. Code lives in repos.
- Use tables for enumerations, prose for reasoning.
- When you cite an external standard (e.g., MADR, C4), link it.

## 7. ADR discipline

Any decision that closes off alternatives gets an ADR. Template: [[adr-template]]. Number monotonically. Never delete — `status: deprecated` and link to the superseding ADR.

## 8. State you should keep in your scratchpad

When working on a long task, keep a `WORKING.md` at the vault root **only for the duration of the task**, then delete it. Do not commit ephemeral state to the vault.

## 9. When in doubt

- Ask the user (use AskUserQuestion in Cowork mode).
- Prefer reading [[reading-paths]] over guessing.
- Prefer adding a stub note over leaving a dangling `[[link]]`.

## See also
- [[HOME]] — the human MOC
- [[reading-paths]] — task → minimum note set
- [[conventions]] — formatting details
- [[glossary]] — domain terms
