import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client, TokenPayload } from 'google-auth-library';

export interface GoogleTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
}

@Injectable()
export class GoogleVerifierService {
  private readonly client: OAuth2Client;
  private readonly clientId: string;

  constructor() {
    this.clientId = process.env.GOOGLE_CLIENT_ID ?? '';
    this.client = new OAuth2Client(this.clientId);
  }

  async verifyIdToken(idToken: string): Promise<GoogleTokenPayload> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException({ code: 'invalid_google_token', message: 'Google ID token verification failed' });
    }

    if (!payload) {
      throw new UnauthorizedException({ code: 'invalid_google_token', message: 'Empty token payload' });
    }

    const iss = payload.iss;
    if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') {
      throw new UnauthorizedException({ code: 'invalid_google_token', message: 'Invalid token issuer' });
    }

    if (!payload.email_verified) {
      throw new UnauthorizedException({ code: 'email_not_verified', message: 'Google email not verified' });
    }

    return {
      sub: payload.sub,
      email: payload.email!,
      email_verified: payload.email_verified,
    };
  }
}
