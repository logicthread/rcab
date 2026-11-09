/**
 * In-page caption overlay burned into the Playwright recording (the ffmpeg build on dev machines has no
 * drawtext). Injected with addInitScript so it survives navigations; state lives in sessionStorage.
 *
 *  - bottom bar: scene id + title, the current step, and a chip row of the state machine with the reached
 *    states highlighted (the transitions shown by the scene),
 *  - title card: full-frame intro, auto-dismissed,
 *  - fake cursor: a red dot that follows the (invisible-in-video) mouse so clicks are legible.
 */
import type { Page } from '@playwright/test';

export interface CaptionState {
  scene: string;
  title: string;
  step: string;
  /** ordered state chips, e.g. ['requested','dispatching','accepted',...] */
  chips: string[];
  /** chips already reached; the last one is rendered as "current" */
  reached: string[];
}

const INIT = `(() => {
  const KEY = '__demo_caption';
  const css = \`
    #__demo_bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483646;background:rgba(15,23,42,.93);color:#f8fafc;
      font:13px/1.35 system-ui,-apple-system,sans-serif;padding:7px 14px 8px;box-sizing:border-box;pointer-events:none}
    #__demo_bar .t{display:flex;gap:8px;align-items:baseline;white-space:nowrap;overflow:hidden}
    #__demo_bar .id{background:#38bdf8;color:#0f172a;font-weight:700;border-radius:4px;padding:1px 6px}
    #__demo_bar .ti{font-weight:600}
    #__demo_bar .st{margin-top:2px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #__demo_bar .ch{margin-top:4px;display:flex;flex-wrap:wrap;gap:4px}
    #__demo_bar .c{border:1px solid #475569;color:#94a3b8;border-radius:10px;padding:0 7px;font-size:11px}
    #__demo_bar .c.r{border-color:#22c55e;color:#bbf7d0;background:rgba(34,197,94,.15)}
    #__demo_bar .c.cur{background:#22c55e;color:#052e16;font-weight:700;border-color:#22c55e}
    #__demo_card{position:fixed;inset:0;z-index:2147483647;background:#0f172a;color:#f8fafc;display:flex;flex-direction:column;
      align-items:center;justify-content:center;text-align:center;font-family:system-ui,-apple-system,sans-serif;padding:40px;box-sizing:border-box;
      transition:opacity .5s}
    #__demo_card .big{font-size:34px;font-weight:700;max-width:900px}
    #__demo_card .sub{margin-top:14px;font-size:18px;color:#cbd5e1;max-width:860px}
    #__demo_card .tag{font-size:14px;letter-spacing:.12em;color:#38bdf8;margin-bottom:14px;font-weight:700}
    #__demo_cursor{position:fixed;z-index:2147483645;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;
      background:rgba(239,68,68,.55);border:2px solid #ef4444;pointer-events:none;left:-50px;top:-50px;transition:left .06s,top .06s}
  \`;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  function render() {
    let st = null;
    try { st = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (_) {}
    let bar = document.getElementById('__demo_bar');
    if (!st) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div'); bar.id = '__demo_bar';
      document.documentElement.appendChild(bar);
    }
    const last = st.reached[st.reached.length - 1];
    bar.innerHTML =
      '<div class="t"><span class="id">' + esc(st.scene) + '</span><span class="ti">' + esc(st.title) + '</span></div>' +
      '<div class="st">' + esc(st.step) + '</div>' +
      (st.chips.length ? '<div class="ch">' + st.chips.map((c) => '<span class="c' +
        (st.reached.includes(c) ? (c === last ? ' cur' : ' r') : '') + '">' + esc(c) + '</span>').join('') + '</div>' : '');
    document.body && (document.body.style.paddingBottom = '92px');
  }
  function boot() {
    if (document.getElementById('__demo_style')) return;
    const s = document.createElement('style'); s.id = '__demo_style'; s.textContent = css;
    document.documentElement.appendChild(s);
    const cur = document.createElement('div'); cur.id = '__demo_cursor'; document.documentElement.appendChild(cur);
    window.addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
    render();
  }
  window.__demoRender = render;
  window.__demoCard = (tag, big, sub, ms) => {
    const old = document.getElementById('__demo_card'); if (old) old.remove();
    const c = document.createElement('div'); c.id = '__demo_card';
    c.innerHTML = '<div class="tag">' + esc(tag) + '</div><div class="big">' + esc(big) + '</div><div class="sub">' + esc(sub) + '</div>';
    document.documentElement.appendChild(c);
    setTimeout(() => { c.style.opacity = '0'; setTimeout(() => c.remove(), 520); }, ms);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();`;

export async function installOverlay(page: Page): Promise<void> {
  await page.addInitScript(INIT);
}

export async function setCaption(page: Page, st: CaptionState): Promise<void> {
  await page
    .evaluate((s) => {
      sessionStorage.setItem('__demo_caption', JSON.stringify(s));
      (window as any).__demoRender?.();
    }, st)
    .catch(() => undefined);
}

export async function showCard(page: Page, tag: string, big: string, sub: string, ms = 3200): Promise<void> {
  await page.evaluate(([t, b, s, m]) => (window as any).__demoCard?.(t, b, s, m), [tag, big, sub, ms] as const).catch(() => undefined);
  await page.waitForTimeout(ms + 600);
}
