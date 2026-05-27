import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface JwtPayload {
  sub: string;
  role: string;
  auth_method: string;
  iss: string;
  iat: number;
  exp: number;
}

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
      const payload = this.jwt.verify<JwtPayload>(token, { issuer: 'rcab' });
      if (!payload.sub) throw new Error('missing sub');
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Invalid or expired token' });
    }
  }
}
