#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets (Redis Lua scripts) from src/ to dist/ so
 * the compiled services find them via `join(__dirname, 'lua', ...)` (F03).
 * `tsc` only emits .ts output; without this step the production image crashes
 * at construction time with ENOENT.
 *
 * Fails (non-zero exit) when a required asset is absent, so a broken build can
 * never be shipped silently.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

/** Assets that the compiled code reads at runtime. Keep in sync with readFileSync callers. */
export const REQUIRED_ASSETS = [
  'modules/matching/lua/pool_slot.lua',
];

const ASSET_EXTENSIONS = new Set(['.lua']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function copyAssets() {
  let copied = 0;
  for (const file of walk(srcDir)) {
    const ext = file.slice(file.lastIndexOf('.'));
    if (!ASSET_EXTENSIONS.has(ext)) continue;
    const dest = join(distDir, relative(srcDir, file));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
    copied++;
  }

  const missing = REQUIRED_ASSETS.filter((a) => !existsSync(join(distDir, a)));
  if (missing.length > 0) {
    console.error(`copy-assets: required runtime assets missing from dist: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`copy-assets: copied ${copied} asset(s) to dist/`);
}

copyAssets();
