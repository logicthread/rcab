#!/usr/bin/env node
// @ts-check
// Vault/code drift check. Compares the feature modules the code actually has
// (dirs under apps/api/src/modules/, from the code graph) against the module
// table hand-maintained in 40-backend/module-map.md.
//
// Exits non-zero on mismatch so it can gate close-story / CI later.
// Usage: node scripts/codegraph/drift-check.mjs   (reads codegraph/graph.json)
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GRAPH = join(ROOT, 'codegraph', 'graph.json');
const MODULE_MAP = join(ROOT, '40-backend', 'module-map.md');

function fail(msg) {
  console.error(`drift-check: ${msg}`);
  process.exit(2);
}

if (!existsSync(GRAPH)) fail('codegraph/graph.json missing — run `pnpm code:graph` first.');
if (!existsSync(MODULE_MAP)) fail('40-backend/module-map.md missing.');

const graph = JSON.parse(readFileSync(GRAPH, 'utf8'));

// Code feature modules = slug dir under apps/api/src/modules/<slug>/
const codeModules = new Set();
for (const n of graph.nodes) {
  if (n.kind !== 'module') continue;
  const m = /apps\/api\/src\/modules\/([^/]+)\//.exec(n.path ?? '');
  if (m) codeModules.add(m[1]);
}

// Declared modules = first-column `backtick` tokens in the module-map table.
const declared = new Set();
for (const line of readFileSync(MODULE_MAP, 'utf8').split('\n')) {
  const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
  if (m) declared.add(m[1]);
}

const phantom = [...declared].filter((s) => !codeModules.has(s)).sort(); // in doc, not in code
const missing = [...codeModules].filter((s) => !declared.has(s)).sort(); // in code, not in doc

console.log(`Code feature modules (${codeModules.size}): ${[...codeModules].sort().join(', ')}`);
console.log(`Doc-declared modules (${declared.size}): ${[...declared].sort().join(', ')}`);

if (!phantom.length && !missing.length) {
  console.log('\n✓ module-map.md is in sync with code.');
  process.exit(0);
}

console.error('\n✗ module-map.md drift vs code:');
if (phantom.length) console.error(`  phantom (in 40-backend/module-map.md, not in code): ${phantom.join(', ')}`);
if (missing.length) console.error(`  missing (in code, not in map):                   ${missing.join(', ')}`);
process.exit(1);
