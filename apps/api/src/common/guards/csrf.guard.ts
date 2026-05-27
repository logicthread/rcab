import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

function allowedOrigins(): Set<string> {
  const env = process.env.ALLOWED_ORIGINS ?? '';
  if (process.env.NODE_ENV !== 'production' && env === '') {
    return new Set(['http://localhost:3001', 'http://localhost:3000']);
  }
  return new Set(
    env
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers['origin'] as string | undefined;

    // No Origin header — same-origin navigation or non-browser client; allow.
    if (!origin) return true;

    if (allowedOrigins().has(origin)) return true;

    throw new ForbiddenException({ code: 'csrf_rejected', message: 'Cross-origin request rejected' });
  }
}
