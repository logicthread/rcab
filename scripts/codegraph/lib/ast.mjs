// @ts-check
// Small syntactic helpers over the TypeScript AST. Everything here is
// parse-only (no type checker) — fast and tsconfig-free.
import ts from 'typescript';

/** All class declarations in a source file (top-level + nested). */
export function findClasses(sf) {
  /** @type {ts.ClassDeclaration[]} */
  const out = [];
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** Decorators on a node, or []. */
export function getDecorators(node) {
  if (!ts.canHaveDecorators(node)) return [];
  return ts.getDecorators(node) ?? [];
}

/** Name of a decorator, e.g. `@Module(...)` → "Module", `@Get()` → "Get". */
export function decoratorName(dec) {
  const expr = dec.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

/** First argument of a decorator call, or undefined. */
export function decoratorArg(dec, index = 0) {
  const expr = dec.expression;
  if (ts.isCallExpression(expr)) return expr.arguments[index];
  return undefined;
}

/** Read a string-literal (or no-substitution template) node → its value. */
export function stringValue(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * Given an ObjectLiteralExpression, return the property assignment value for a
 * named key (e.g. the `imports` array inside `@Module({...})`).
 */
export function objectProp(objLiteral, key) {
  if (!objLiteral || !ts.isObjectLiteralExpression(objLiteral)) return undefined;
  for (const prop of objLiteral.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === key) {
      return prop.initializer;
    }
  }
  return undefined;
}

/**
 * From an array-literal, return the bare identifier names only. Entries that are
 * call expressions (ConfigModule.forRoot(), BullModule.registerQueue()) or spreads
 * are skipped — those are dynamic/external and not internal graph nodes.
 */
export function arrayIdentifiers(arrNode) {
  if (!arrNode || !ts.isArrayLiteralExpression(arrNode)) return [];
  const out = [];
  for (const el of arrNode.elements) {
    if (ts.isIdentifier(el)) out.push(el.text);
  }
  return out;
}

export { ts };
