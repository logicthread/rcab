// @ts-check
// HTTP routes. For each `@Controller('prefix')` class, each method decorated
// with @Get/@Post/@Put/@Patch/@Delete becomes a route node:
//   route:<METHOD> <fullpath>   (controller prefix + method path, normalized)
// plus a `route` edge controller-symbol → route node.
import { ts, findClasses, getDecorators, decoratorName, decoratorArg, stringValue } from '../lib/ast.mjs';

const HTTP_METHODS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All']);

function joinPath(prefix, sub) {
  const parts = [prefix, sub].filter((p) => p && p.length).join('/');
  return ('/' + parts).replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

/**
 * @param {ts.SourceFile} sf
 * @param {{ graph: import('../lib/graph.mjs').Graph, relPath: string, app: string }} ctx
 */
export function extractNestRoutes(sf, ctx) {
  const { graph, relPath, app } = ctx;

  for (const cls of findClasses(sf)) {
    const ctrlDec = getDecorators(cls).find((d) => decoratorName(d) === 'Controller');
    if (!ctrlDec || !cls.name) continue;
    const controller = cls.name.text;
    const prefix = stringValue(decoratorArg(ctrlDec)) ?? '';

    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      const handler = member.name.text;
      for (const dec of getDecorators(member)) {
        const method = decoratorName(dec);
        if (!method || !HTTP_METHODS.has(method)) continue;
        const sub = stringValue(decoratorArg(dec)) ?? '';
        const httpMethod = method.toUpperCase();
        const fullPath = joinPath(prefix, sub);
        const routeId = `route:${httpMethod} ${fullPath}`;
        graph.addNode({
          id: routeId,
          kind: 'route',
          path: relPath,
          name: `${httpMethod} ${fullPath}`,
          app,
          meta: { method: httpMethod, path: fullPath, controller, handler },
        });
        graph.addEdge(`${relPath}#${controller}`, routeId, 'route', { handler });
      }
    }
  }
}
