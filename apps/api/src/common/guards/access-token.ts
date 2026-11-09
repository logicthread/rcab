import type { JwtService } from '@nestjs/jwt';
import { getPolicy } from '../../config/policy/policy';

/**
 * rcab access-token claims (F11). Every access token carries a fixed issuer,
 * audience and token type, and every verifier checks all three — so a token
 * minted for another purpose with the same key (e.g. a quote token, issuer
 * `rcab-quote`) can never be presented as an access token.
 */
export const JWT_ISSUER = 'rcab';
export const JWT_AUDIENCE = 'rcab-api';
export const ACCESS_TOKEN_TYPE = 'access';
/** Policy `sessions.accessTokenTtlS` (default 900 s, env ACCESS_TOKEN_TTL_S). */
export const ACCESS_TOKEN_TTL_SECONDS: number = getPolicy().sessions.accessTokenTtlS;

export interface AccessTokenClaims {
  sub: string;
  role: string;
  auth_method: string;
}

export interface JwtPayload extends AccessTokenClaims {
  typ: typeof ACCESS_TOKEN_TYPE;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export function signAccessToken(jwt: JwtService, claims: AccessTokenClaims): string {
  return jwt.sign(
    { sub: claims.sub, role: claims.role, auth_method: claims.auth_method, typ: ACCESS_TOKEN_TYPE },
    { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );
}

/** Throws on a bad signature, expiry, wrong issuer/audience/type or missing subject. */
export function verifyAccessToken(jwt: JwtService, token: string): JwtPayload {
  const payload = jwt.verify<JwtPayload>(token, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  });
  if (payload.typ !== ACCESS_TOKEN_TYPE) throw new Error('not an access token');
  if (typeof payload.sub !== 'string' || payload.sub === '') throw new Error('missing sub');
  return payload;
}
