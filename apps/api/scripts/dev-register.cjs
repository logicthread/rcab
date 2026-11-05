/**
 * Dev-time TypeScript loader (F04). Registers a `.ts` require hook that
 * compiles with SWC and, crucially, EMITS DECORATOR METADATA
 * (`design:paramtypes`). Nest relies on that metadata for implicit constructor
 * injection (`constructor(private readonly pricing: PricingService)`); the
 * previous runner, `tsx` (esbuild), emits none, so every implicitly-injected
 * provider received `undefined` in dev while working in vitest/prod.
 *
 * SWC does not type-check — run `tsc --noEmit` (pnpm typecheck) for that.
 *
 * Usage: node --watch-path=./src -r ./scripts/dev-register.cjs src/main.ts
 */
const fs = require('node:fs');
const { transformSync } = require('@swc/core');

const options = {
  swcrc: false,
  configFile: false,
  sourceMaps: 'inline',
  module: { type: 'commonjs' },
  jsc: {
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
    target: 'es2022',
    keepClassNames: true,
  },
};

// Overrides Node's built-in type-stripping (22.18+), which has no decorator support.
require.extensions['.ts'] = function compileTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const { code } = transformSync(source, { ...options, filename });
  module._compile(code, filename);
};
