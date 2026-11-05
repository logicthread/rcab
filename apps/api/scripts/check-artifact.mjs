#!/usr/bin/env node
/**
 * Artifact smoke test (F03): run AFTER `pnpm build`. Asserts that the Lua assets
 * sit beside the compiled services and that the compiled (not source) services
 * can actually read them at construction time — i.e. what the production image
 * does at boot, with no src/ tree involved.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);

// Stage C removed the last Lua scripts (pool_claim, pool_slot); keep the list
// so a future runtime asset is checked the same way.
const required = [];
for (const rel of required) {
  const p = join(dist, rel);
  assert.ok(existsSync(p), `dist/${rel} is missing — run \`pnpm build\``);
  assert.equal(
    readFileSync(p, 'utf-8'),
    readFileSync(join(root, 'src', rel), 'utf-8'),
    `dist/${rel} differs from src/${rel}`,
  );
}

require('reflect-metadata');
// The compiled services must load from dist without the source tree.
for (const mod of ['modules/dispatch/dispatch.service.js', 'modules/matching/pool-lifecycle.service.js']) {
  require(join(dist, mod));
}

console.log('check-artifact: dist runtime assets present and compiled services load');
