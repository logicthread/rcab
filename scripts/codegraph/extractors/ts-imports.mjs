// @ts-check
// File node + static import edges. Also returns the file's import map
// (local name → resolved node id | external) which the DI/route extractors reuse.
import { ts } from '../lib/ast.mjs';
import { resolveImport } from '../lib/resolve.mjs';

const APP_BY_PREFIX = [
  ['apps/api/', 'api'],
  ['apps/web/', 'web'],
  ['apps/driver-app/', 'driver-app'],
  ['packages/shared/', 'shared'],
  ['packages/api-client/', 'api-client'],
  ['packages/test-fixtures/', 'test-fixtures'],
];

/** Bucket a repo-relative path into a workspace app label. */
export function appOf(relPath) {
  for (const [prefix, app] of APP_BY_PREFIX) if (relPath.startsWith(prefix)) return app;
  return 'other';
}

/**
 * @param {ts.SourceFile} sf
 * @param {{ graph: import('../lib/graph.mjs').Graph, relPath: string, absPath: string, rootAbs: string }} ctx
 * @returns {Map<string, { id: string|null, kind: string }>} importMap: localName → resolution
 */
export function extractImports(sf, ctx) {
  const { graph, relPath, absPath, rootAbs } = ctx;
  graph.addNode({ id: relPath, kind: 'file', path: relPath, name: relPath.split('/').pop(), app: appOf(relPath) });

  /** @type {Map<string, { id: string|null, kind: string }>} */
  const importMap = new Map();

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const specNode = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(specNode)) continue;
    const spec = specNode.text;
    const resolved = resolveImport(spec, absPath, rootAbs);

    // record local binding names so DI/route extractors can map identifier → source
    const clause = stmt.importClause;
    if (clause) {
      if (clause.name) importMap.set(clause.name.text, resolved); // default import
      const named = clause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) importMap.set(el.name.text, resolved);
      }
      if (named && ts.isNamespaceImport(named)) importMap.set(named.name.text, resolved);
    }

    // graph edge only for internal (resolved) imports
    if (resolved.id) graph.addEdge(relPath, resolved.id, 'imports', { spec });
  }

  return importMap;
}
