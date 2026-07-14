---
name: code-graph
description: Query the committed code knowledge graph (codegraph/graph.json) to navigate the rcab codebase without grepping source — who imports X, what a NestJS module depends on, where a route lives, what tables/providers exist. Regenerates if stale. Args: a question like "importers <file>", "deps <Module>", "route <METHOD /path>", "tables", "symbol <Name>", "modules", or "regen".
---

# code-graph

Answers structural questions about the rcab codebase from `codegraph/graph.json` — a
precomputed graph of files, NestJS modules, routes, DB tables, and providers with
edges for imports / DI wiring / routes / FK / Riverpod. Use this **instead of grepping
source** for "where/what/who" navigation questions.

The graph is built by `scripts/codegraph/build.mjs` (in-repo TypeScript compiler API for
TS, regex for Dart). Node kinds: `file | module | symbol | route | table`. Edge kinds:
`imports | di-import | di-provides | route | fk | riverpod-provides`.

## Inputs

A single free-form question (see table). No arg → print the summary counts + module list.

## Steps

1. **Ensure the graph is fresh.** If `codegraph/.stale` exists (the PostToolUse hook
   flags it when source under `apps/**|packages/**` changes), regenerate before answering:
   ```bash
   [ -f codegraph/.stale ] && pnpm code:graph && rm -f codegraph/.stale
   ```
   The `gitSha`/`generatedAt` fields in `graph.json` are informational (they record the
   commit the graph was built at) — don't gate freshness on them: the committed graph
   necessarily stores the pre-commit sha, so a sha comparison would always look stale.

2. **Answer via `jq` over `codegraph/graph.json`.** Never grep source for these — the
   graph already has the answer:

   | Question | Command |
   |---|---|
   | `importers <path>` — who imports a file | `jq -r --arg p "<path>" '.edges[]\|select(.to==$p and .kind=="imports")\|.from' codegraph/graph.json` |
   | `deps <Module>` — what a module DI-imports | `jq -r --arg m "<Module>" '.edges[]\|select((.from\|test($m)) and .kind=="di-import")\|.to' codegraph/graph.json` |
   | `rdeps <Module>` — who DI-imports a module | `jq -r --arg m "<Module>" '.edges[]\|select((.to\|test($m)) and .kind=="di-import")\|.from' codegraph/graph.json` |
   | `route <METHOD /path>` — locate a route | `jq -r --arg r "route:<METHOD /path>" '.nodes[]\|select(.id==$r)\|.path+" → "+.meta.controller+"."+.meta.handler' codegraph/graph.json` |
   | `routes` — list all routes | `jq -r '.nodes[]\|select(.kind=="route")\|.meta.method+" "+.meta.path' codegraph/graph.json \| sort` |
   | `tables` — list tables + FKs | `jq -r '.edges[]\|select(.kind=="fk")\|.from+" -> "+.to' codegraph/graph.json` |
   | `symbol <Name>` — locate a class/provider | `jq -r --arg n "<Name>" '.nodes[]\|select(.name==$n)\|.kind+" "+.path' codegraph/graph.json` |
   | `modules` — module DI tree | read `codegraph/graph.md` (NestJS modules section) |
   | `regen` | `pnpm code:graph && rm -f codegraph/.stale` |

3. **Prefer `codegraph/graph.md`** for a human-readable overview (module tree, routes,
   tables) when the user wants a map rather than a single lookup.

4. **Report** the answer with `file:line`-style paths so results are clickable. If a
   lookup returns nothing, say so and suggest the closest match (e.g. `symbol` by
   substring: `jq -r --arg n "<Name>" '.nodes[]|select(.name|test($n;"i"))|.name'`).

## Anti-drift

`pnpm code:graph:check` compares the graph's real modules against
`40-backend/module-map.md` and exits non-zero on mismatch. Run it when the user asks
whether the docs match the code, or as part of close-story.

## When to use

- Orienting on an unfamiliar module before a story (faster than Explore for structure).
- "What breaks if I change X" → `importers`/`rdeps`.
- Verifying a doc claim about modules/routes/tables against reality.
- Any "where is / who calls / what depends on" question about TS or Dart code.
