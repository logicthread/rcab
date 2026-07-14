// @ts-check
// Drizzle schema graph. Each `export const X = pgTable('pg_name', { cols }, ...)`
// becomes a table node `table:X`. Each column's `.references(() => Other.col)`
// becomes an fk edge table:X → table:Other.
import { ts } from '../lib/ast.mjs';

/** Column property names from the pgTable columns object (2nd arg). */
function columnNames(objLiteral) {
  if (!objLiteral || !ts.isObjectLiteralExpression(objLiteral)) return [];
  return objLiteral.properties
    .filter((p) => ts.isPropertyAssignment(p) && p.name && ts.isIdentifier(p.name))
    .map((p) => p.name.text);
}

/** Find every `.references(() => Target.col)` target identifier within a node. */
function referencedTables(node) {
  const targets = new Set();
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'references' &&
      n.arguments.length
    ) {
      // arg is `() => Target.col` — find the first PropertyAccess's object identifier
      const findTarget = (x) => {
        if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression)) return x.expression.text;
        let found;
        ts.forEachChild(x, (child) => {
          if (!found) found = findTarget(child);
        });
        return found;
      };
      const target = findTarget(n.arguments[0]);
      if (target) targets.add(target);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...targets];
}

/**
 * @param {ts.SourceFile} sf
 * @param {{ graph: import('../lib/graph.mjs').Graph, relPath: string, app: string }} ctx
 */
export function extractDrizzleFk(sf, ctx) {
  const { graph, relPath, app } = ctx;

  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (
          init &&
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'pgTable' &&
          ts.isIdentifier(decl.name)
        ) {
          const constName = decl.name.text;
          const pgName = init.arguments[0] && ts.isStringLiteral(init.arguments[0]) ? init.arguments[0].text : constName;
          const tableId = `table:${constName}`;
          graph.addNode({
            id: tableId,
            kind: 'table',
            path: relPath,
            name: constName,
            app,
            meta: { pgName, columns: columnNames(init.arguments[1]) },
          });
          for (const target of referencedTables(init)) {
            graph.addNode({ id: `table:${target}`, kind: 'table', path: relPath, name: target, app });
            graph.addEdge(tableId, `table:${target}`, 'fk', {});
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
