import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { register } from 'prom-client';
import type { Request, Response } from 'express';
import { MetricsMiddleware, routeLabel } from './metrics.middleware';
import { UNMATCHED_ROUTE } from '../../metrics';

async function count(route: string, status: string, method = 'GET'): Promise<number> {
  const json = await register.getMetricsAsJSON();
  const m = json.find((x) => x.name === 'http_request_duration_seconds');
  return (m?.values as Array<{ value: number; labels: Record<string, string>; metricName?: string }>)
    .filter(
      (v) =>
        v.metricName === 'http_request_duration_seconds_count' &&
        v.labels.route === route &&
        v.labels.status_code === status &&
        v.labels.method === method,
    )
    .reduce((s, v) => s + v.value, 0);
}

function run(req: Partial<Request>, statusCode: number): void {
  const res = Object.assign(new EventEmitter(), { statusCode }) as unknown as Response;
  new MetricsMiddleware().use(
    { method: 'GET', headers: {}, ...req } as Request,
    res,
    () => undefined,
  );
  (res as unknown as EventEmitter).emit('finish');
}

describe('routeLabel', () => {
  it('is the matched route template, not the raw path', () => {
    expect(routeLabel({ route: { path: '/v1/rides/:id' }, baseUrl: '' } as never)).toBe('/v1/rides/:id');
    expect(routeLabel({ route: { path: '/v1/rides/:id/cancel' } } as never)).toBe('/v1/rides/:id/cancel');
  });

  it('prefixes a mounted router base', () => {
    expect(routeLabel({ route: { path: '/:id' }, baseUrl: '/v1/rides' } as never)).toBe('/v1/rides/:id');
  });

  it('is one fixed label when no route matched (404, preflight, scanner)', () => {
    expect(routeLabel({ baseUrl: '' } as never)).toBe(UNMATCHED_ROUTE);
    expect(routeLabel({ route: undefined } as never)).toBe(UNMATCHED_ROUTE);
    expect(routeLabel({ route: { path: '' } } as never)).toBe(UNMATCHED_ROUTE);
    expect(routeLabel({ route: { path: /^\/regex/ } } as never)).toBe(UNMATCHED_ROUTE);
  });
});

describe('MetricsMiddleware', () => {
  it('collapses /v1/rides/<uuid> to /v1/rides/:id: different ids are ONE series', async () => {
    const before = await count('/v1/rides/:id', '200');
    for (const id of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      run({ path: `/v1/rides/${id}`, route: { path: '/v1/rides/:id' } as never, baseUrl: '' }, 200);
    }
    expect(await count('/v1/rides/:id', '200')).toBe(before + 2);

    const json = await register.getMetricsAsJSON();
    const routes = new Set(
      (json.find((x) => x.name === 'http_request_duration_seconds')!.values as Array<{ labels: Record<string, string> }>).map(
        (v) => v.labels.route,
      ),
    );
    expect([...routes].filter((r) => r.includes('1111') || r.includes('2222'))).toEqual([]);
  });

  it('files unknown paths under the fixed unmatched label', async () => {
    const before = await count(UNMATCHED_ROUTE, '404');
    run({ path: '/wp-login.php', baseUrl: '' }, 404);
    run({ path: `/probe/${Math.random()}`, baseUrl: '' }, 404);
    expect(await count(UNMATCHED_ROUTE, '404')).toBe(before + 2);
  });
});
