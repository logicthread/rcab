import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { resolveBrowserOrigins } from './auth-config';

function refererOrigin(referer: string): string | null {
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function reject(): never {
  throw new ForbiddenException({ code: 'csrf_rejected', message: 'Cross-origin request rejected' });
}

/**
 * Origin check for cookie-authenticated session changes (web refresh/logout).
 *
 * The allowlist is the same validated list main.ts gives credentialed CORS
 * (CORS_ORIGINS), resolved once at construction so a missing or invalid
 * production list fails startup instead of being discovered per request.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowed: ReadonlySet<string>;

  constructor() {
    this.allowed = new Set(resolveBrowserOrigins());
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers['origin'] as string | undefined;
    const referer = req.headers['referer'] as string | undefined;

    if (origin !== undefined) {
      if (this.allowed.has(origin)) return true;
      reject();
    }

    // No Origin: some browsers omit it on same-origin POSTs but still send
    // Referer — when present it must point at an allowed origin.
    if (referer !== undefined) {
      const fromReferer = refererOrigin(referer);
      if (fromReferer !== null && this.allowed.has(fromReferer)) return true;
      reject();
    }

    // Neither header: a non-browser client, which carries no ambient cookies to abuse.
    return true;
  }
}
