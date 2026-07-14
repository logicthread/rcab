// @ts-check
// Import-specifier resolution for the code graph.
// Turns an import specifier (as written in source) into a repo-relative file
// node id, or null when it points outside the graph (npm packages).
//
// Rules mirror how the repo actually links:
//   - relative  './x' / '../x'  → resolve against the file dir, try .ts/.tsx/index
//   - workspace '@rcab/<pkg>'   → packages/<pkg>/src/index.ts
//   - web alias '@/x'           → apps/web/src/x  (only meaningful under apps/web)
//   - anything else             → external (null)

import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'];

/** Try each suffix; return the first existing absolute path, else null. */
function firstExisting(baseAbs) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = baseAbs + suffix;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const WORKSPACE_PACKAGES = new Set(['shared', 'api-client', 'test-fixtures']);

/**
 * @param {string} spec      import specifier as written
 * @param {string} fromAbs   absolute path of the importing file
 * @param {string} rootAbs   absolute repo root
 * @returns {{ id: string, kind: 'relative'|'workspace'|'web-alias' } | { id: null, kind: 'external' }}
 */
export function resolveImport(spec, fromAbs, rootAbs) {
  // relative
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const abs = firstExisting(resolve(dirname(fromAbs), spec));
    if (abs) return { id: relative(rootAbs, abs), kind: 'relative' };
    return { id: null, kind: 'external' };
  }
  // @rcab/<pkg> workspace package
  if (spec.startsWith('@rcab/')) {
    const pkg = spec.slice('@rcab/'.length).split('/')[0];
    if (WORKSPACE_PACKAGES.has(pkg)) {
      const abs = firstExisting(join(rootAbs, 'packages', pkg, 'src', 'index'));
      if (abs) return { id: relative(rootAbs, abs), kind: 'workspace' };
    }
    return { id: null, kind: 'external' };
  }
  // web '@/...' alias → apps/web/src/...
  if (spec.startsWith('@/')) {
    const abs = firstExisting(join(rootAbs, 'apps', 'web', 'src', spec.slice('@/'.length)));
    if (abs) return { id: relative(rootAbs, abs), kind: 'web-alias' };
    return { id: null, kind: 'external' };
  }
  return { id: null, kind: 'external' };
}
