// Recording primitives: headless Chromium + injected caption bar + ffmpeg -> H.264 MP4.
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, OUT_DIR, WORK_DIR, COMPOSE, AREAS, policyR2Meters, haversineM } from './config.mjs';

// Playwright is a devDependency of apps/web, not of the workspace root.
const requireFromWeb = createRequire(join(ROOT, 'apps/web/package.json'));
export const { chromium } = requireFromWeb('@playwright/test');

export const FFMPEG = process.env.FFMPEG || (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
export const FFPROBE = process.env.FFPROBE || (existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log('[demo:ops]', ...a);

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 600)}`);
  }
  return r;
}
export const compose = (...args) => sh('docker', [...COMPOSE, ...args]);

export function ensureDirs() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
}

// ---------------------------------------------------------------- preflight / load helpers

/** Refuse to generate traffic anywhere that could collide with the other demo fixtures (Area A / B). */
export function assertAreaCIsolated() {
  const r2 = policyR2Meters();
  for (const k of ['A', 'B']) {
    const d = haversineM(AREAS.C, AREAS[k]);
    if (d <= r2) throw new Error(`Area C is only ${Math.round(d)} m from Area ${k}; dispatch.r2Meters is ${r2} m`);
    log(`Area C is ${Math.round(d)} m from Area ${k} (dispatch.r2Meters = ${r2} m): isolated`);
  }
}

/** Mint dev-only fixture tokens + park k6's simulated drivers in Area C (infra/load/prepare-dev.mjs). */
export function prepareLoad(ttlS = 1800) {
  const { lat, lng } = AREAS.C;
  sh('node', ['infra/load/prepare-dev.mjs', '--base-lat', String(lat), '--base-lng', String(lng), '--ttl-s', String(ttlS)]);
}
export function cleanLoad() {
  sh('node', ['infra/load/prepare-dev.mjs', '--clean'], { allowFail: true });
}

/** Start k6 in the background; resolves with its exit code when it finishes. Output goes to WORK_DIR. */
export function startK6({ name, duration = '40s', scenarios = 'quote,ride_create,offer_contention,driver_location', extraEnv = {} }) {
  const out = join(WORK_DIR, `k6-${name}.log`);
  const env = { ...process.env, DURATION: duration, SCENARIOS: scenarios, RIDER_VUS: '1', QUOTE_RATE: '6', ...extraEnv };
  const child = spawn('sh', ['-c', `k6 run --quiet infra/load/workload.js > "${out}" 2>&1`], { cwd: ROOT, env, stdio: 'ignore' });
  log(`k6 started (${scenarios}, ${duration}) -> ${out}`);
  return new Promise((resolve) => child.on('exit', (code) => { log(`k6 ${name} finished (exit ${code}; non-zero = a threshold tripped, fine for a demo)`); resolve(code); }));
}

// ---------------------------------------------------------------- browser scenes

const OVERLAY_JS = () => {
  const mount = () => {
    if (document.getElementById('__rcab_cap')) return;
    const el = document.createElement('div');
    el.id = '__rcab_cap';
    el.setAttribute('style', [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647', 'pointer-events:none',
      'background:rgba(8,12,20,.88)', 'color:#e8eefc', 'font:600 15px/1.35 -apple-system,Segoe UI,Helvetica,Arial,sans-serif',
      'padding:9px 16px', 'display:flex', 'gap:12px', 'align-items:center', 'border-top:2px solid #4f8cff',
    ].join(';'));
    el.innerHTML = '<span id="__rcab_cap_id" style="background:#4f8cff;color:#04101f;border-radius:4px;padding:1px 8px;font-weight:800"></span><span id="__rcab_cap_txt"></span>';
    (document.body || document.documentElement).appendChild(el);
    window.__rcabPaint && window.__rcabPaint();
  };
  window.__rcabPaint = () => {
    const c = window.__rcabCaption || {};
    const a = document.getElementById('__rcab_cap_id'), b = document.getElementById('__rcab_cap_txt');
    if (a) a.textContent = c.id || '';
    if (b) b.textContent = c.text || '';
  };
  document.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('load', mount);
  setInterval(mount, 500); // single-page apps replace <body> content; keep the bar mounted
};

function titleCardHtml({ id, title, lines }) {
  const li = lines.map((l) => `<li>${l.replace(/</g, '&lt;')}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:radial-gradient(circle at 30% 20%,#14233f,#070b14);color:#e8eefc;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<div style="width:960px"><div style="color:#7fb0ff;font-weight:800;letter-spacing:.14em;font-size:20px">RCAB ONBOARDING &middot; OPS &amp; MONITORING</div>
<div style="font-size:84px;font-weight:800;margin:10px 0 0">${id}</div>
<div style="font-size:44px;font-weight:700;margin:4px 0 26px">${title}</div>
<ul style="font-size:24px;line-height:1.5;color:#b8c7e6;padding-left:28px;margin:0">${li}</ul></div></body>`;
}

/**
 * Record one browser scene. `run(page, cap)` drives the page; `cap(text)` updates the caption bar.
 * Returns the path of the converted MP4.
 */
export async function recordScene(scene, run, { storageState } = {}) {
  ensureDirs();
  const vdir = join(WORK_DIR, `video-${scene.id}`);
  rmSync(vdir, { recursive: true, force: true });
  mkdirSync(vdir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: { dir: vdir, size: { width: 1280, height: 720 } },
    ...(storageState ? { storageState } : {}),
  });
  await context.addInitScript(OVERLAY_JS);
  const page = await context.newPage();
  let current = { id: scene.id, text: '' };
  const paint = () => page.evaluate((c) => { window.__rcabCaption = c; window.__rcabPaint && window.__rcabPaint(); }, current).catch(() => {});
  page.on('domcontentloaded', paint);
  const cap = async (text) => { current = { id: scene.id, text }; await paint(); };

  try {
    await page.setContent(titleCardHtml({ id: scene.id, title: scene.title, lines: scene.card }));
    await sleep(3800);
    await run(page, cap);
    await sleep(1200);
  } finally {
    await context.close(); // flushes the .webm
    await browser.close();
  }
  const webm = readdirSync(vdir).find((f) => f.endsWith('.webm'));
  if (!webm) throw new Error(`no video produced for ${scene.id}`);
  return toMp4(join(vdir, webm), scene);
}

export function toMp4(input, scene) {
  const out = join(OUT_DIR, `${scene.id}-${scene.slug}.mp4`);
  const r = sh(FFMPEG, ['-y', '-loglevel', 'error', '-i', input, '-an', '-vf', 'fps=25,scale=1280:720:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', out]);
  void r;
  return out;
}

export function probe(file) {
  const r = sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'default=nw=1', file]);
  const d = Number((r.stdout.match(/duration=([\d.]+)/) || [])[1]);
  const s = Number((r.stdout.match(/size=(\d+)/) || [])[1]);
  return { seconds: Math.round(d * 10) / 10, mb: Math.round((s / 1048576) * 100) / 100 };
}

/** Wheel-scroll gently so the viewer can follow. */
export async function scrollDown(page, { x = 640, y = 380, steps = 6, px = 300, pause = 1400 } = {}) {
  await page.mouse.move(x, y);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px);
    await sleep(pause);
  }
}

export function writeJson(file, obj) { writeFileSync(file, JSON.stringify(obj, null, 2) + '\n'); }
export { statSync };
