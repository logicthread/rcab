import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../infra/db/drizzle.module';
import { FirebaseAdminService } from '../../infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../infra/google/google-verifier.service';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../../common/guards/access-token';

const PHONE_E164_RE = /^\+[1-9]\d{7,14}$/;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_BYTES = 32;

/** app_user.status values that may not obtain or renew a session (F12). */
export const BLOCKED_USER_STATUSES: readonly string[] = ['suspended', 'deleted'];

export type AuthMethod = 'phone' | 'google';

export interface TokenResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: typeof ACCESS_TOKEN_TTL_SECONDS;
  refresh_token: string;
  user: { id: string; role: string; phone_e164: string };
}

interface SessionUser {
  id: string;
  role: string;
  phone_e164: string;
  status: string;
}

interface ConsumedRefreshRow {
  user_id: string;
  family_id: string;
  auth_method: AuthMethod;
  role: string;
  phone_e164: string;
  status: string;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Refresh tokens are 256-bit random values; only their SHA-256 digest is
 * stored (F12), so a database read never yields a usable credential. A plain
 * (unkeyed) digest is sufficient because the input is high-entropy.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

function invalidRefresh(message: string): UnauthorizedException {
  return new UnauthorizedException({ code: 'invalid_refresh_token', message });
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(FirebaseAdminService) private firebase: FirebaseAdminService,
    @Inject(GoogleVerifierService) private google: GoogleVerifierService,
    @Inject(JwtService) private jwt: JwtService,
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
    this.assertAccountActive(user.status);
    return this.issueSession(this.pool, user, 'phone', randomUUID());
  }

  /**
   * Single-use rotation (F12). The validity check and the consumption are one
   * conditional UPDATE inside the transaction, so of N concurrent requests
   * presenting the same token exactly one can consume it. Presenting a token
   * that was already consumed or revoked is treated as replay and revokes the
   * token's whole session family.
   */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const tokenHash = hashRefreshToken(refreshToken);
    const client = await this.pool.connect();
    let outcome: TokenResponse | UnauthorizedException;
    try {
      await client.query('BEGIN');
      const consumed = await client.query<ConsumedRefreshRow>(
        `UPDATE auth_refresh_token art
            SET revoked_at = now()
           FROM app_user au
          WHERE art.token_hash = $1
            AND art.revoked_at IS NULL
            AND art.expires_at > now()
            AND au.id = art.user_id
        RETURNING art.user_id, art.family_id, art.auth_method, au.role, au.phone_e164, au.status`,
        [tokenHash],
      );

      if (consumed.rows.length === 0) {
        // Unknown, expired, or already used. A known token that is already
        // revoked is a replay: revoke whatever is still live in its family.
        await client.query(
          `UPDATE auth_refresh_token SET revoked_at = now()
            WHERE revoked_at IS NULL
              AND family_id = (SELECT family_id FROM auth_refresh_token
                                WHERE token_hash = $1 AND revoked_at IS NOT NULL)`,
          [tokenHash],
        );
        outcome = invalidRefresh('Refresh token is invalid, expired, or already used');
      } else {
        const row = consumed.rows[0];
        if (BLOCKED_USER_STATUSES.includes(row.status)) {
          await client.query(
            'UPDATE auth_refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [row.user_id],
          );
          outcome = new UnauthorizedException({ code: 'account_disabled', message: 'Account is not active' });
        } else {
          outcome = await this.issueSession(
            client,
            { id: row.user_id, role: row.role, phone_e164: row.phone_e164, status: row.status },
            row.auth_method,
            row.family_id,
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (outcome instanceof UnauthorizedException) throw outcome;
    return outcome;
  }

  async revoke(refreshToken: string, userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE auth_refresh_token SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL',
      [hashRefreshToken(refreshToken), userId],
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

    const result = await this.pool.query<SessionUser>(
      'SELECT id, role, phone_e164, status FROM app_user WHERE google_sub = $1',
      [sub],
    );

    if (result.rows.length === 0) {
      throw new UnauthorizedException({ code: 'not_found', message: 'No account linked to this Google identity' });
    }

    const user = result.rows[0];
    this.assertAccountActive(user.status);
    return this.issueSession(this.pool, user, 'google', randomUUID());
  }

  private assertAccountActive(status: string): void {
    if (BLOCKED_USER_STATUSES.includes(status)) {
      throw new ForbiddenException({ code: 'account_disabled', message: 'Account is not active' });
    }
  }

  /** Mints an access token and stores the digest of a fresh refresh token in `familyId`. */
  private async issueSession(
    db: Queryable,
    user: SessionUser,
    authMethod: AuthMethod,
    familyId: string,
  ): Promise<TokenResponse> {
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await db.query(
      `INSERT INTO auth_refresh_token (token_hash, family_id, user_id, auth_method, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [hashRefreshToken(refreshToken), familyId, user.id, authMethod, expiresAt],
    );

    return {
      access_token: signAccessToken(this.jwt, { sub: user.id, role: user.role, auth_method: authMethod }),
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      user: { id: user.id, role: user.role, phone_e164: user.phone_e164 },
    };
  }

  private async findOrCreateUser(firebaseUid: string, phone: string): Promise<SessionUser> {
    const existing = await this.pool.query<SessionUser>(
      'SELECT id, role, phone_e164, status FROM app_user WHERE firebase_uid = $1',
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
      return { id: userId, role: 'client', phone_e164: phone, status: 'active' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
