// @ts-check
// NestJS DI graph. For each `@Module({ imports, providers, controllers, exports })`
// class: create a module node and edges:
//   di-import   module → module   (internal @Module dependencies)
//   di-provides module → symbol   (provider/controller classes it owns)
import { ts, findClasses, getDecorators, decoratorName, decoratorArg, objectProp, arrayIdentifiers } from '../lib/ast.mjs';

/**
 * Resolve an identifier used inside a @Module array to a node id, using the
 * file's import map. Returns { id, external } — external when it comes from an
 * npm package (e.g. ConfigModule) or can't be resolved.
 */
function resolveIdentifier(name, importMap) {
  const hit = importMap.get(name);
  if (hit && hit.id) return { id: `${hit.id}#${name}`, external: false };
  // defined in this same file (not imported) — caller passes selfPath
  return { id: null, external: true, name };
}

/**
 * @param {ts.SourceFile} sf
 * @param {{ graph: import('../lib/graph.mjs').Graph, relPath: string, app: string }} ctx
 * @param {Map<string, { id: string|null, kind: string }>} importMap
 */
export function extractNestDi(sf, ctx, importMap) {
  const { graph, relPath, app } = ctx;

  for (const cls of findClasses(sf)) {
    const dec = getDecorators(cls).find((d) => decoratorName(d) === 'Module');
    if (!dec || !cls.name) continue;
    const className = cls.name.text;
    const moduleId = `${relPath}#${className}`;

    const objArg = decoratorArg(dec);
    const importIds = arrayIdentifiers(objArg && objectProp(objArg, 'imports'));
    const providerIds = arrayIdentifiers(objArg && objectProp(objArg, 'providers'));
    const controllerIds = arrayIdentifiers(objArg && objectProp(objArg, 'controllers'));
    const exportIds = arrayIdentifiers(objArg && objectProp(objArg, 'exports'));

    graph.addNode({
      id: moduleId,
      kind: 'module',
      path: relPath,
      name: className,
      app,
      meta: { imports: importIds, providers: providerIds, controllers: controllerIds, exports: exportIds },
    });

    // di-import: internal module → module edges only
    for (const name of importIds) {
      const r = resolveIdentifier(name, importMap);
      if (r.id) {
        graph.addNode({ id: r.id, kind: 'module', path: importMap.get(name)?.id, name, app });
        graph.addEdge(moduleId, r.id, 'di-import', {});
      }
    }

    // di-provides: module → symbol (providers + controllers it owns)
    for (const name of [...providerIds, ...controllerIds]) {
      const hit = importMap.get(name);
      const symId = hit && hit.id ? `${hit.id}#${name}` : `${relPath}#${name}`;
      graph.addNode({ id: symId, kind: 'symbol', path: hit?.id ?? relPath, name, app });
      graph.addEdge(moduleId, symId, 'di-provides', {});
    }
  }
}
