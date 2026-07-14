#!/usr/bin/env node
// @ts-check
// Code knowledge graph builder for rcab.
//
// Walks the TypeScript surface (apps/api, apps/web, packages/*) once per file
// with the in-repo TypeScript compiler API (syntactic, no type checker) plus the
// Drizzle schema and the Dart driver-app, and emits:
//   codegraph/graph.json   machine-readable graph (nodes + edges + counts)
//   codegraph/graph.md     agent/human-readable map
//
// Usage: node scripts/codegraph/build.mjs [--output <dir>] [--markdown-only]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, globSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseArgsUtil } from 'node:util';
import ts from 'typescript';

import { Graph } from './lib/graph.mjs';
import { extractImports, appOf } from './extractors/ts-imports.mjs';
import { extractNestDi } from './extractors/nest-di.mjs';
import { extractNestRoutes } from './extractors/nest-routes.mjs';
import { extractDrizzleFk } from './extractors/drizzle-fk.mjs';
import { extractDart } from './extractors/dart-riverpod.mjs';
import { toMarkdown } from './emit-markdown.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const { values } = parseArgsUtil({
  options: {
    output: { type: 'string', default: join(ROOT, 'codegraph') },
    'markdown-only': { type: 'boolean', default: false },
    'push-memory': { type: 'boolean', default: false },
  },
});

const TS_GLOBS = ['apps/api/src/**/*.ts', 'apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx', 'packages/*/src/**/*.ts'];
const TS_IGNORE = /\.(spec|test)\.tsx?$|\.d\.ts$/;

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// generatedAt: pull from git commit time to stay deterministic (Date.now is banned
// in some contexts and would make every run churn the artifact).
function generatedAt() {
  try {
    return execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch {
    return '1970-01-01T00:00:00Z';
  }
}

function tsFiles() {
  const seen = new Set();
  for (const pattern of TS_GLOBS) {
    for (const rel of globSync(pattern, { cwd: ROOT })) {
      if (TS_IGNORE.test(rel)) continue;
      seen.add(rel.split('\\').join('/'));
    }
  }
  return [...seen].sort();
}

function main() {
  const graph = new Graph();

  for (const relPath of tsFiles()) {
    const absPath = join(ROOT, relPath);
    const src = readFileSync(absPath, 'utf8');
    const sf = ts.createSourceFile(absPath, src, ts.ScriptTarget.ES2022, /* setParentNodes */ true, ts.ScriptKind.TS);
    const app = appOf(relPath);
    const ctx = { graph, relPath, absPath, rootAbs: ROOT, app };

    const importMap = extractImports(sf, ctx);
    extractNestDi(sf, ctx, importMap);
    extractNestRoutes(sf, ctx, importMap);

    // the Drizzle schema is a single well-known file
    if (relPath === 'apps/api/src/db/schema.ts') extractDrizzleFk(sf, ctx);
  }

  // Dart driver app (regex-based, separate toolchain)
  extractDart({ graph, rootAbs: ROOT });

  const json = graph.toJSON({ gitSha: gitSha(), generatedAt: generatedAt() });

  mkdirSync(values.output, { recursive: true });
  if (!values['markdown-only']) {
    writeFileSync(join(values.output, 'graph.json'), JSON.stringify(json, null, 2) + '\n');
  }
  writeFileSync(join(values.output, 'graph.md'), toMarkdown(json));

  const c = json.counts;
  console.log(
    `code graph: ${c.nodes} nodes, ${c.edges} edges → ${relative(ROOT, values.output)}/graph.json`,
  );
  console.log(`  nodes: ${Object.entries(c.byNodeKind).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  console.log(`  edges: ${Object.entries(c.byEdgeKind).map(([k, v]) => `${v} ${k}`).join(', ')}`);

  if (values['push-memory']) pushToMemory(json);
}

function pushToMemory(json) {
  // Optional stretch: emit a memory-ingest payload the /code-graph skill can
  // hand to mcp__memory__. We don't call the MCP from node (no client here);
  // we write a sidecar the skill reads. Off by default.
  const entities = json.nodes
    .filter((n) => n.kind === 'module' || n.kind === 'table')
    .map((n) => ({ name: n.name, entityType: n.kind, observations: [`path: ${n.path}`] }));
  const relations = json.edges
    .filter((e) => e.kind === 'di-import' || e.kind === 'fk')
    .map((e) => ({ from: e.from.split('#').pop(), to: e.to.split('#').pop(), relationType: e.kind }));
  writeFileSync(join(values.output, 'memory-ingest.json'), JSON.stringify({ entities, relations }, null, 2) + '\n');
  console.log(`  memory-ingest: ${entities.length} entities, ${relations.length} relations`);
}

main();
