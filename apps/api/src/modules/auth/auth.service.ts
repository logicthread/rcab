import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PG_POOL } from '../../infra/db/drizzle.module';
import { FirebaseAdminService } from '../../infra/firebase/firebase-admin.service';

const PHONE_E164_RE = /^\+[1-9]\d{7,14}$/;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TokenResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: 900;
  refresh_token: string;
  user: { id: string; role: string; phone_e164: string };
}

@Injectable()
export class AuthService {
  constructor(
    private firebase: FirebaseAdminService,
    private jwt: JwtService,
    @Inject(PG_POOL) private pool: Pool,
  ) {}

  async exchangeFirebaseToken(idToken: string): Promise<TokenResponse> {
    let decoded: Awaited<ReturnType<FirebaseAdminService['verifyIdToken']>>;
    try {
      decoded = await this.firebase.verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException({
        code: 'invalid_firebase_token',
        message: 'Firebase token verification failed',
      });
    }

    const phone = decoded.phone_number;
    if (!phone || !PHONE_E164_RE.test(phone)) {
      throw new UnauthorizedException({
        code: 'invalid_firebase_token',
        message: 'Token must contain a valid E.164 phone number',
      });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (decoded.iat !== undefined && nowSec - decoded.iat > 3600) {
      throw new UnauthorizedException({
        code: 'invalid_firebase_token',
        message: 'Token is too old',
      });
    }

    const user = await this.findOrCreateUser(decoded.uid, phone);

    const accessToken = this.jwt.sign({
      sub: user.id,
      role: user.role,
      auth_method: 'phone',
    });

    const refreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await this.pool.query(
      'INSERT INTO auth_refresh_token (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [refreshToken, user.id, expiresAt],
    );

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 900,
      refresh_token: refreshToken,
      user: { id: user.id, role: user.role, phone_e164: user.phone_e164 },
    };
  }

  private async findOrCreateUser(
    firebaseUid: string,
    phone: string,
  ): Promise<{ id: string; role: string; phone_e164: string }> {
    const existing = await this.pool.query<{ id: string; role: string; phone_e164: string }>(
      'SELECT id, role, phone_e164 FROM app_user WHERE firebase_uid = $1',
      [firebaseUid],
    );
    if (existing.rows.length > 0) return existing.rows[0];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const userId = randomUUID();
      await client.query(
        "INSERT INTO app_user (id, firebase_uid, phone_e164, role, status) VALUES ($1, $2, $3, 'client', 'active')",
        [userId, firebaseUid, phone],
      );
      await client.query('INSERT INTO client (user_id) VALUES ($1)', [userId]);
      await client.query('COMMIT');
      return { id: userId, role: 'client', phone_e164: phone };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
