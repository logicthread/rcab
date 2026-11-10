import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';

/** A Google identity whose email Google has verified (RCAB-E8.S15). */
export interface GoogleTokenPayload {
  /** Stable Google account id — the login key (`app_user.google_sub`). */
  sub: string;
  email: string;
  email_verified: true;
}

const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Accepted OAuth client ids (token audiences). Infra config, not policy:
 * `GOOGLE_CLIENT_IDS` is a comma list (the web client id; the Android app
 * passes that same web id as `serverClientId`, so usually one entry);
 * `GOOGLE_CLIENT_ID` is the single-id back-compat alias, used only when
 * `GOOGLE_CLIENT_IDS` is unset or empty. Values containing `<` or `>` (the
 * env-example placeholders) count as unset.
 */
export function resolveGoogleClientIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.GOOGLE_CLIENT_IDS?.trim() ? env.GOOGLE_CLIENT_IDS : (env.GOOGLE_CLIENT_ID ?? '');
  const ids = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && !/[<>]/.test(v));
  return [...new Set(ids)];
}

function invalid(message: string): UnauthorizedException {
  return new UnauthorizedException({ code: 'google_token_invalid', message });
}

/**
 * Verifies a Google ID token directly with Google (signature against Google's
 * published certs, audience, expiry) and then checks issuer, expiry, subject
 * and `email_verified` itself. No Firebase. With no client id configured the
 * service still constructs (the API boots) and every verification answers
 * 503 `google_not_configured`.
 */
@Injectable()
export class GoogleVerifierService {
  private readonly client = new OAuth2Client();
  private readonly audiences: readonly string[];

  constructor() {
    this.audiences = Object.freeze(resolveGoogleClientIds());
  }

  /** The accepted audiences, first one = the client id advertised to clients. */
  get clientIds(): readonly string[] {
    return this.audiences;
  }

  /** The client id clients should request tokens for, or null when unconfigured. */
  get primaryClientId(): string | null {
    return this.audiences[0] ?? null;
  }

  get isConfigured(): boolean {
    return this.audiences.length > 0;
  }

  async verifyIdToken(idToken: string): Promise<GoogleTokenPayload> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException({
        code: 'google_not_configured',
        message: 'Google sign-in is not configured on this server',
      });
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: [...this.audiences] });
      payload = ticket.getPayload();
    } catch {
      throw invalid('Google ID token verification failed');
    }

    if (!payload) throw invalid('Empty token payload');
    if (!GOOGLE_ISSUERS.has(payload.iss)) throw invalid('Invalid token issuer');
    // The library already rejects expired tokens and foreign audiences; both
    // are re-checked so a library change cannot silently widen acceptance.
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw invalid('Token expired');
    if (typeof payload.aud !== 'string' || !this.audiences.includes(payload.aud)) {
      throw invalid('Token audience is not accepted');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw invalid('Token has no subject');

    if (payload.email_verified !== true || typeof payload.email !== 'string' || payload.email.length === 0) {
      throw new ForbiddenException({
        code: 'google_email_unverified',
        message: 'Google has not verified the email of this account',
      });
    }

    return { sub: payload.sub, email: payload.email, email_verified: true };
  }
}
