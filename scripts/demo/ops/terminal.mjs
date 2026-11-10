// M06: run real tooling commands, then render the captured sessions as a typed-out terminal replay video.
// (Headless Chromium cannot screen-capture a real terminal, so the replay is a styled HTML page; the COMMANDS
// and their OUTPUT are real - captured seconds earlier - and any trimmed output is marked as elided.)
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, WORK_DIR, URLS } from './config.mjs';
import { recordScene, log, compose } from './lib.mjs';

const SNIP = 'scripts/demo/ops/snippets';
export const STEPS = [
  { title: 'Is the dev stack healthy? (api + postgres + redis + osrm)', cmd: 'pnpm dev:smoke' },
  { title: 'Do metrics reach Prometheus?', cmd: 'pnpm obs:smoke' },
  { title: 'Host capability and port preflight', cmd: `pnpm system:probe --ci --output ${join(WORK_DIR, 'system-probe.json')}`, shown: 'pnpm system:probe --ci' },
  { title: 'redis-inspect: presence, BullMQ queues, caches (commands from .claude/skills/redis-inspect)', cmd: `bash ${SNIP}/redis-inspect.sh`, shown: 'bash scripts/demo/ops/snippets/redis-inspect.sh' },
  { title: 'pool-inspect: authoritative shared-ride rows + matching queue (.claude/skills/pool-inspect)', cmd: `bash ${SNIP}/pool-inspect.sh`, shown: 'bash scripts/demo/ops/snippets/pool-inspect.sh' },
  { title: 'Policy drift gate: docs/POLICY.md must match policy.schema.ts', cmd: 'pnpm policy:doc:check' },
  { title: 'Backup + restore drill on FIXTURE data (throwaway containers, ~60 s real time)', cmd: 'bash scripts/recovery/backup-rehearsal.sh', trim: { head: 4, tail: 26 } },
];

const ANSI_FG = { 30: '#6b7280', 31: '#ff6b6b', 32: '#5ee38b', 33: '#ffd166', 34: '#6ea8ff', 35: '#d38bff', 36: '#5fe3e3', 37: '#e5e7eb',
  90: '#8b95a7', 91: '#ff8f8f', 92: '#8cf2ac', 93: '#ffe08a', 94: '#9cc3ff', 95: '#e2adff', 96: '#8cf0f0', 97: '#ffffff' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function ansiToHtml(line) {
  line = line.replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, ''); // non-colour CSI
  let out = '', open = false, style = {};
  const flush = () => { if (open) { out += '</span>'; open = false; } };
  const apply = (codes) => {
    for (const c of codes) {
      if (c === 0) style = {};
      else if (c === 1) style.b = true;
      else if (c === 2) style.d = true;
      else if (c === 22) { style.b = false; style.d = false; }
      else if (ANSI_FG[c]) style.fg = ANSI_FG[c];
      else if (c === 39) style.fg = null;
    }
  };
  let last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let m;
  const emit = (text) => {
    if (!text) return;
    const css = [style.fg ? `color:${style.fg}` : '', style.b ? 'font-weight:700' : '', style.d ? 'opacity:.62' : ''].filter(Boolean).join(';');
    flush();
    out += css ? `<span style="${css}">${esc(text)}</span>` : esc(text);
  };
  while ((m = re.exec(line))) { emit(line.slice(last, m.index)); apply(m[1] === '' ? [0] : m[1].split(';').map(Number)); last = re.lastIndex; }
  emit(line.slice(last));
  return out;
}

function capture(step) {
  log(`terminal: running ${step.cmd}`);
  const r = spawnSync('bash', ['-lc', `{ ${step.cmd}; } 2>&1`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1' }, timeout: 240000 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  let lines = text.split('\n').map((l) => l.split('\r').pop()).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  let elided = 0;
  if (step.trim && lines.length > step.trim.head + step.trim.tail) {
    elided = lines.length - step.trim.head - step.trim.tail;
    lines = [...lines.slice(0, step.trim.head), `\x1b[2m... ${elided} lines elided in this replay (the real run prints them all) ...\x1b[0m`, ...lines.slice(-step.trim.tail)];
  }
  if (lines.length > 70) { elided = lines.length - 60; lines = [...lines.slice(0, 20), `\x1b[2m... ${elided} lines elided ...\x1b[0m`, ...lines.slice(-40)]; }
  return { title: step.title, cmd: step.shown || step.cmd, exit: r.status, lines: lines.map(ansiToHtml) };
}

function html(data) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0b0f17;color:#e5e7eb">
<pre id="t" style="margin:0;padding:18px 20px 70px;height:632px;overflow:hidden;font:14.5px/1.28 ui-monospace,'SF Mono',Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all"></pre>
<script>
const DATA=${JSON.stringify(data).replace(/</g, '\\u003c')};
const t=document.getElementById('t');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cap=(id,text)=>{window.__rcabCaption={id,text};window.__rcabPaint&&window.__rcabPaint();};
(async()=>{
  for(const [i,s] of DATA.entries()){
    t.innerHTML='';
    cap('M06 '+(i+1)+'/'+DATA.length, s.title);
    const line=document.createElement('div');
    line.innerHTML='<span style="color:#5ee38b">rcab</span> <span style="color:#6ea8ff">~/rcab</span> <span style="color:#8b95a7">$</span> ';
    const typed=document.createElement('span'); line.appendChild(typed); t.appendChild(line);
    const caret=document.createElement('span'); caret.textContent='\\u2588'; caret.style.opacity='.7'; line.appendChild(caret);
    await sleep(500);
    for(const ch of s.cmd){typed.textContent+=ch;await sleep(22);}
    await sleep(450); caret.remove();
    const per=Math.max(8,Math.min(45,2600/Math.max(1,s.lines.length)));
    for(const l of s.lines){const d=document.createElement('div');d.innerHTML=l||'&nbsp;';t.appendChild(d);t.scrollTop=t.scrollHeight;await sleep(per);}
    const ok=document.createElement('div');
    ok.innerHTML='<span style="color:'+(s.exit===0?'#5ee38b':'#ff6b6b')+'">[exit '+s.exit+']</span>';
    t.appendChild(ok);t.scrollTop=t.scrollHeight;
    await sleep(Math.min(5200,2600+s.lines.length*45));
  }
  window.__done=true;
})();
</script>`;
}

/** Open ONE shared-ride pool in Area C (as a k6 fixture client) so pool-inspect has a real row to show. */
async function openDemoPool() {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Re-read the tokens each attempt (another harness may have re-minted them) and never reuse a keep-alive socket.
      const t = JSON.parse(readFileSync(join(ROOT, 'infra/load/tokens.generated.json'), 'utf8'));
      const H = { 'content-type': 'application/json', connection: 'close', authorization: `Bearer ${t.clients[1].token}` };
      const body = { type: 'shared', originLat: t.base.lat, originLng: t.base.lng, destLat: t.base.lat + 0.018, destLng: t.base.lng + 0.012, seats: 1 };
      const q = await (await fetch(`${URLS.api}/v1/rides/quote`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
      const r = await fetch(`${URLS.api}/v1/rides`, { method: 'POST', headers: { ...H, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ ...body, quoteToken: q.quoteToken }) });
      const j = await r.json();
      if (r.status !== 201 || !j.sharedRideId) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      log(`demo pool ${j.sharedRideId} (${j.poolStatus})`);
      return j.sharedRideId;
    } catch (e) {
      lastErr = e;
      log(`WARN could not open demo pool (attempt ${attempt}/3): ${e.cause?.code || e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`could not open demo pool: ${lastErr?.message}`);
}

/** Remove only the pool this run created (dev DB, fixture rows). */
function dropDemoPool(id) {
  const sql = `BEGIN; DELETE FROM dispatch_offer WHERE shared_ride_id='${id}'; DELETE FROM pool_member WHERE pool_id='${id}'; DELETE FROM shared_rides WHERE ride_id='${id}'; COMMIT;`;
  compose('exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'rcab', '-d', 'rcab', '-c', sql);
  compose('exec', '-T', 'redis', 'redis-cli', 'DEL', `pool:${id}`);
}

export async function runTerminalScene(scene) {
  const poolId = await openDemoPool();
  let data;
  try {
    data = STEPS.map(capture);
  } finally {
    try { dropDemoPool(poolId); } catch (e) { log(`WARN could not drop demo pool ${poolId}: ${e.message}`); }
  }
  writeFileSync(join(WORK_DIR, 'terminal-capture.json'), JSON.stringify(data, null, 2));
  return recordScene(scene, async (page) => {
    await page.setContent(html(data));
    await page.waitForFunction('window.__done === true', null, { timeout: 240000, polling: 500 });
  });
}
