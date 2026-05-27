import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { httpRequestDuration } from '../../metrics';
import { logger } from '../../logger';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const route = req.path ?? 'unknown';
      const method = req.method ?? 'UNKNOWN';
      const statusCode = res.statusCode;
      httpRequestDuration.labels(method, route, String(statusCode)).observe(durationMs / 1000);
      const isHealth = route.startsWith('/v1/health') || route === '/';
      const logLevel = isHealth ? 'debug' : 'info';
      logger[logLevel](
        { method, route, status: statusCode, duration_ms: Math.round(durationMs * 100) / 100, request_id: req.headers['x-request-id'] },
        'request',
      );
    });
    next();
  }
}
