import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, UNMATCHED_ROUTE } from '../../metrics';
import { logger } from '../../logger';

/**
 * The metric label for a request: the matched route TEMPLATE (`/v1/rides/:id`),
 * never the raw path, so ids cannot mint one time series each. Resolved at
 * response time (Express fills `req.route` once a handler matched). A request
 * that matched no route (404, CORS preflight, scanners) is the fixed
 * {@link UNMATCHED_ROUTE}, which also bounds label cardinality against hostile
 * clients probing random URLs.
 */
export function routeLabel(req: Pick<Request, 'route' | 'baseUrl'>): string {
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string' || path === '') return UNMATCHED_ROUTE;
  return `${req.baseUrl ?? ''}${path}`;
}

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const route = routeLabel(req);
      const method = req.method ?? 'UNKNOWN';
      const statusCode = res.statusCode;
      httpRequestDuration.labels(method, route, String(statusCode)).observe(durationMs / 1000);
      const isHealth = route.startsWith('/v1/health') || route === '/' || route === '/metrics';
      const logLevel = isHealth ? 'debug' : 'info';
      logger[logLevel](
        {
          method,
          route,
          // Raw path only in the log line (investigations); never a label.
          path: req.path,
          status: statusCode,
          duration_ms: Math.round(durationMs * 100) / 100,
          request_id: req.headers['x-request-id'],
        },
        'request',
      );
    });
    next();
  }
}
