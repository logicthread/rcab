import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/** Claims locked into a signed quote token (fare + route the client was shown). */
export interface QuoteClaims {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  soloFareCents: number;
  distanceM: number;
  durationS: number;
}

// Distinct issuer so an auth JWT can never be replayed as a quote token (and
// vice versa) — both are signed with the same secret via JwtService.
const QUOTE_ISSUER = 'rcab-quote';
const QUOTE_TTL = '5m';

/**
 * Signs/verifies short-lived quote tokens. The token lets the booking request
 * (RCAB-E4.S2) commit the exact fare + route the client was quoted, and expires
 * after 5 min per the normal-booking spec, forcing a re-quote afterwards.
 */
@Injectable()
export class QuoteTokenService {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  sign(claims: QuoteClaims): string {
    return this.jwt.sign(claims, { issuer: QUOTE_ISSUER, expiresIn: QUOTE_TTL });
  }

  /** Throws `TokenExpiredError` (expired) / `JsonWebTokenError` (tampered). */
  verify(token: string): QuoteClaims {
    return this.jwt.verify<QuoteClaims>(token, { issuer: QUOTE_ISSUER });
  }
}
