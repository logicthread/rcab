import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { verifyAccessToken, type JwtPayload } from './access-token';

export type { JwtPayload } from './access-token';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Missing Bearer token' });
    }
    const token = authHeader.slice(7);
    try {
      req.user = verifyAccessToken(this.jwt, token);
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Invalid or expired token' });
    }
  }
}
