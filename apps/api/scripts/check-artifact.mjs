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

const required = [
  'modules/dispatch/lua/pool_claim.lua',
  'modules/matching/lua/pool_slot.lua',
];
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
const config = { get: () => undefined };
const stub = {};

const { DispatchService } = require(join(dist, 'modules/dispatch/dispatch.service.js'));
const dispatch = new DispatchService(stub, stub, stub, stub, stub, stub, stub, stub, config);
assert.match(dispatch.poolClaimScript, /redis\.call/, 'dispatch pool_claim script not loaded');

const { PoolLifecycleService } = require(join(dist, 'modules/matching/pool-lifecycle.service.js'));
const lifecycle = new PoolLifecycleService(stub, stub, stub, stub, stub, config);
assert.match(lifecycle.poolSlotScript, /redis\.call/, 'matching pool_slot script not loaded');

console.log('check-artifact: dist Lua assets present and readable by compiled services');
