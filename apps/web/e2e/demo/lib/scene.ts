/**
 * Scene harness: a recording browser context per scene (1280x720 by default), session setup for fixture
 * users, captions, and a metadata JSON that record.mjs turns into the mp4 + INDEX.md.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, WEB_BASE, createRefreshToken } from './devstack';
import { installOverlay, setCaption, showCard } from './overlay';
import type { Person } from './fixtures';

export const OUT_DIR = join(REPO_ROOT, 'apps/web/e2e/demo/out');
export const RAW_DIR = join(OUT_DIR, 'raw');

export interface SceneMeta {
  id: string; // W03
  slug: string; // normal-ride-lifecycle
  title: string;
  shows: string;
  /** state-machine chips shown in the caption bar */
  chips: string[];
  /** transitions / states the scene demonstrates (for INDEX.md) */
  transitions: string;
  /** side-by-side composition (W07): list of panel names in left-to-right order */
  panels?: string[];
  notes?: string;
}

export interface ScenePage {
  name: string;
  openedAtMs: number;
  ctx: BrowserContext;
  page: Page;
}

export class Scene {
  readonly pages: ScenePage[] = [];
  private reached = new Map<string, string[]>();
  private started = Date.now();

  constructor(
    readonly meta: SceneMeta,
    private readonly browser: Browser,
  ) {
    mkdirSync(RAW_DIR, { recursive: true });
  }

  /** New recorded context/page. `person` = signed-in fixture client (refresh cookie); omit for signed-out. */
  async open(
    name: string,
    opts: { person?: Person; viewport?: { width: number; height: number } } = {},
  ): Promise<Page> {
    const viewport = opts.viewport ?? { width: 1280, height: 720 };
    const ctx = await this.browser.newContext({
      viewport,
      recordVideo: { dir: join(RAW_DIR, `${this.meta.id}-${name}`), size: viewport },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    if (opts.person) {
      const raw = createRefreshToken(opts.person.id);
      await ctx.addCookies([
        {
          name: 'refresh_token',
          value: raw,
          domain: new URL(WEB_BASE).hostname,
          path: '/v1/auth',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
          expires: Math.floor(Date.now() / 1000) + 86400,
        },
      ]);
    }
    const page = await ctx.newPage();
    await installOverlay(page);
    this.pages.push({ name, ctx, page, openedAtMs: Date.now() });
    this.reached.set(name, []);
    return page;
  }

  /** Update the caption of a page; `state` (if given) is appended to the reached chips. */
  async step(page: Page, text: string, state?: string): Promise<void> {
    const entry = this.pages.find((p) => p.page === page);
    const key = entry?.name ?? '';
    const reached = this.reached.get(key) ?? [];
    if (state && !reached.includes(state)) reached.push(state);
    this.reached.set(key, reached);
    if (process.env.DEMO_TRACE) console.log(`[${this.meta.id} +${this.elapsedS().toFixed(1)}s] ${text}`);
    await setCaption(page, {
      scene: this.meta.id,
      title: this.meta.title + (this.meta.panels && entry ? ` - ${entry.name}` : ''),
      step: text,
      chips: this.meta.chips,
      reached: [...reached],
    });
  }

  async intro(page: Page, ms = 3200): Promise<void> {
    await showCard(page, `${this.meta.id}  ·  ${this.meta.slug}`, this.meta.title, this.meta.shows, ms);
  }

  elapsedS(): number {
    return (Date.now() - this.started) / 1000;
  }

  /** Close contexts (flushes videos) and write the metadata record.mjs consumes. */
  async finish(extra: Record<string, unknown> = {}): Promise<void> {
    const videos: Array<{ name: string; path: string; openedAtMs: number }> = [];
    for (const p of this.pages) {
      const v = p.page.video();
      await p.ctx.close();
      if (v) videos.push({ name: p.name, path: await v.path(), openedAtMs: p.openedAtMs });
    }
    writeFileSync(
      join(RAW_DIR, `${this.meta.id}.json`),
      JSON.stringify({ ...this.meta, videos, recordedAt: new Date().toISOString(), wallClockS: Math.round(this.elapsedS()), ...extra }, null, 2),
    );
  }
}
