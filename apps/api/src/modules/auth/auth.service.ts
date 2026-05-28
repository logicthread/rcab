import { Injectable, UnauthorizedException, ConflictException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PG_POOL } from '../../infra/db/drizzle.module';
import { FirebaseAdminService } from '../../infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../infra/google/google-verifier.service';

const PHONE_E164_RE = /^\+[1-9]\d{7,14}$/;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface RefreshRow {
  user_id: string;
  role: string;
  phone_e164: string;
  expires_at: Date;
  revoked_at: Date | null;
}

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
    private google: GoogleVerifierService,
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

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const result = await this.pool.query<RefreshRow & { phone_e164: string }>(
      `SELECT art.user_id, art.expires_at, art.revoked_at, au.role, au.phone_e164
       FROM auth_refresh_token art
       JOIN app_user au ON au.id = art.user_id
       WHERE art.token = $1`,
      [refreshToken],
    );

    if (result.rows.length === 0) {
      throw new UnauthorizedException({ code: 'invalid_refresh_token', message: 'Refresh token not found' });
    }

    const row = result.rows[0];
    if (row.revoked_at !== null) {
      throw new UnauthorizedException({ code: 'invalid_refresh_token', message: 'Refresh token has been revoked' });
    }
    if (new Date(row.expires_at) < new Date()) {
      throw new UnauthorizedException({ code: 'invalid_refresh_token', message: 'Refresh token has expired' });
    }

    const newRefreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE auth_refresh_token SET revoked_at = now() WHERE token = $1',
        [refreshToken],
      );
      await client.query(
        'INSERT INTO auth_refresh_token (token, user_id, expires_at) VALUES ($1, $2, $3)',
        [newRefreshToken, row.user_id, expiresAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const accessToken = this.jwt.sign({ sub: row.user_id, role: row.role, auth_method: 'phone' });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 900,
      refresh_token: newRefreshToken,
      user: { id: row.user_id, role: row.role, phone_e164: row.phone_e164 },
    };
  }

  async revoke(refreshToken: string, userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE auth_refresh_token SET revoked_at = now() WHERE token = $1 AND user_id = $2 AND revoked_at IS NULL',
      [refreshToken, userId],
    );
  }

  async linkGoogle(userId: string, googleIdToken: string): Promise<void> {
    const { sub, email } = await this.google.verifyIdToken(googleIdToken);

    // Check if this google_sub is already linked to a different user
    const existing = await this.pool.query<{ user_id: string }>(
      'SELECT id AS user_id FROM app_user WHERE google_sub = $1',
      [sub],
    );
    if (existing.rows.length > 0 && existing.rows[0].user_id !== userId) {
      throw new ConflictException({ code: 'google_already_linked', message: 'Google account linked to another user' });
    }

    // Idempotent upsert — already linked to this user is a no-op
    await this.pool.query(
      'UPDATE app_user SET google_sub = $1, email = $2 WHERE id = $3',
      [sub, email, userId],
    );
  }

  async loginWithGoogle(googleIdToken: string): Promise<TokenResponse> {
    const { sub } = await this.google.verifyIdToken(googleIdToken);

    const result = await this.pool.query<{ id: string; role: string; phone_e164: string }>(
      'SELECT id, role, phone_e164 FROM app_user WHERE google_sub = $1',
      [sub],
    );

    if (result.rows.length === 0) {
      throw new UnauthorizedException({ code: 'not_found', message: 'No account linked to this Google identity' });
    }

    const user = result.rows[0];
    const accessToken = this.jwt.sign({ sub: user.id, role: user.role, auth_method: 'google' });

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
