// @ts-check
// Flutter driver-app graph (regex — Dart has no in-repo parser). Emits:
//   file node per lib/**/*.dart
//   imports edge for relative imports that resolve to another lib file
//   riverpod-provides edge  file → symbol  for `final xProvider = ...Provider(...)`
import { readFileSync, globSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const IMPORT_RE = /^\s*import\s+'([^']+)'/gm;
// final <name>Provider = <...>Provider<...>(...)   (also *NotifierProvider etc.)
const PROVIDER_RE = /^\s*final\s+(_?\w+Provider)\s*=/gm;

/**
 * @param {{ graph: import('../lib/graph.mjs').Graph, rootAbs: string }} ctx
 */
export function extractDart({ graph, rootAbs }) {
  const files = globSync('apps/driver-app/lib/**/*.dart', { cwd: rootAbs })
    .map((p) => p.split('\\').join('/'))
    .sort();

  for (const relPath of files) {
    const absPath = join(rootAbs, relPath);
    const src = readFileSync(absPath, 'utf8');
    graph.addNode({ id: relPath, kind: 'file', path: relPath, name: relPath.split('/').pop(), app: 'driver-app' });

    // relative imports → resolve to sibling lib file
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (spec.startsWith('package:') || spec.startsWith('dart:')) continue; // external
      const targetAbs = resolve(dirname(absPath), spec);
      const targetRel = relative(rootAbs, targetAbs).split('\\').join('/');
      if (targetRel.startsWith('apps/driver-app/lib/')) {
        graph.addEdge(relPath, targetRel, 'imports', { spec });
      }
    }

    // Riverpod provider declarations
    for (const m of src.matchAll(PROVIDER_RE)) {
      const name = m[1];
      const symId = `${relPath}#${name}`;
      graph.addNode({ id: symId, kind: 'symbol', path: relPath, name, app: 'driver-app' });
      graph.addEdge(relPath, symId, 'riverpod-provides', {});
    }
  }
}
