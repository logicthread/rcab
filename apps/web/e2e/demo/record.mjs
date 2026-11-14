#!/usr/bin/env node
/**
 * Record the web demo scenes and publish them (RCAB-E8.S14).
 *
 *   node apps/web/e2e/demo/record.mjs [W03 W07 ...]     # no ids = every scene
 *   pnpm demo:record:web [-- W03 W07]
 *
 * 1. runs the Playwright demo config (headless chromium, 1280x720, slowMo) for the chosen scenes,
 * 2. converts each raw .webm to H.264 MP4 (ffmpeg; W07 composes two recorded panels side by side),
 * 3. writes docs/onboarding/videos/web/<ID>-<slug>.mp4, updates scenes.json and regenerates INDEX.md.
 *
 * Needs the dev stack up (`pnpm dev:up`, seeded per scripts/seed-dev.sh is NOT required) and ffmpeg
 * (FFMPEG=/path to override; default: ffmpeg on PATH or /opt/homebrew/bin/ffmpeg).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const webDir = join(root, 'apps/web');
const rawDir = join(here, 'out/raw');
const outDir = join(root, 'docs/onboarding/videos/web');
const manifestPath = join(outDir, 'scenes.json');
const FFMPEG = process.env.FFMPEG ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');
const MAX_MB = 12;

const ids = process.argv.slice(2).filter((a) => /^W\d\d$/i.test(a)).map((a) => a.toUpperCase());
const skipRun = process.argv.includes('--convert-only');

mkdirSync(outDir, { recursive: true });
if (!skipRun) {
  for (const id of ids) {
    for (const f of existsSync(rawDir) ? readdirSync(rawDir) : []) if (f.startsWith(`${id}`)) rmSync(join(rawDir, f), { recursive: true, force: true });
  }
  if (ids.length === 0) rmSync(rawDir, { recursive: true, force: true });
  const grep = ids.length ? ['-g', ids.map((i) => `${i} `).join('|')] : [];
  const r = spawnSync('npx', ['playwright', 'test', '-c', 'e2e/demo/playwright.demo.config.ts', ...grep], { cwd: webDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[demo:record:web] playwright run failed; converting whatever was recorded');
  }
}

const probe = (f) => Number(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());
const ff = (args) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};
const enc = (crf) => ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];

const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const metas = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => /^W\d\d\.json$/.test(f)) : [];
for (const mf of metas) {
  const meta = JSON.parse(readFileSync(join(rawDir, mf), 'utf8'));
  if (ids.length && !ids.includes(meta.id)) continue;
  const mp4 = join(outDir, `${meta.id}-${meta.slug}.mp4`);
  const vids = meta.videos;
  if (!vids.length) continue;
  for (const crf of [28, 31, 34]) {
    if (vids.length === 1) {
      ff(['-i', vids[0].path, '-vf', 'fps=25', ...enc(crf), mp4]);
    } else {
      // Side by side: align each panel to the first one's start (recording starts when its context opened).
      const t0 = Math.min(...vids.map((v) => v.openedAtMs));
      const inputs = vids.flatMap((v) => ['-i', v.path]);
      const pads = vids.map((v, i) => `[${i}:v]fps=25,tpad=start_duration=${((v.openedAtMs - t0) / 1000).toFixed(2)}:color=white[p${i}]`).join(';');
      const stack = vids.map((_, i) => `[p${i}]`).join('') + `hstack=inputs=${vids.length}:shortest=0[v]`;
      ff([...inputs, '-filter_complex', `${pads};${stack}`, '-map', '[v]', ...enc(crf), mp4]);
    }
    if (statSync(mp4).size <= MAX_MB * 1024 * 1024) break;
  }
  const seconds = Math.round(probe(mp4));
  const mb = Math.round((statSync(mp4).size / 1024 / 1024) * 10) / 10;
  if (seconds < 15 || seconds > 150) console.warn(`[demo:record:web] WARNING ${meta.id}: ${seconds}s is outside 15-150 s`);
  manifest[meta.id] = {
    id: meta.id,
    slug: meta.slug,
    title: meta.title,
    shows: meta.shows,
    transitions: meta.transitions,
    notes: meta.notes ?? '',
    file: `${meta.id}-${meta.slug}.mp4`,
    seconds,
    mb,
    panels: meta.panels ?? null,
    recordedAt: meta.recordedAt,
  };
  console.log(`[demo:record:web] ${meta.id} -> ${mp4} (${seconds}s, ${mb} MB)`);
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeIndex();

function writeIndex() {
  const rows = Object.values(manifest).sort((a, b) => a.id.localeCompare(b.id));
  const total = rows.reduce((s, r) => s + r.mb, 0);
  const intro = existsSync(join(here, 'INDEX.header.md')) ? readFileSync(join(here, 'INDEX.header.md'), 'utf8') : '';
  const table = [
    '| ID | Video | Length | Size | What it shows | States / transitions |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| <a id="${r.id.toLowerCase()}"></a>${r.id} | [${r.title}](${r.file}) | ${r.seconds} s | ${r.mb} MB | ${r.shows} | ${r.transitions} |`),
  ].join('\n');
  const notes = rows
    .filter((r) => r.notes)
    .map((r) => `- **${r.id}** (${r.file}): ${r.notes}`)
    .join('\n');
  const regen = rows.map((r) => `| ${r.id} | \`pnpm demo:record:web -- ${r.id}\` |`).join('\n');
  writeFileSync(
    join(outDir, 'INDEX.md'),
    `${intro}\n## Videos\n\n${table}\n\nTotal: ${rows.length} videos, ${Math.round(total * 10) / 10} MB.\n\n## Per-scene notes\n\n${notes || '(none)'}\n\n## Regenerate\n\n| Scene | Command |\n|---|---|\n${regen}\n\nAll scenes: \`pnpm demo:record:web\`. Harness and prerequisites: [apps/web/e2e/demo/README.md](../../../../apps/web/e2e/demo/README.md).\n`,
  );
}
