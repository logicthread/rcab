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
import { POLICY, getPolicy } from '../../config/policy/policy';
import type { AuthMethodName, Policy } from '../../config/policy/policy.schema';

const PHONE_E164_RE = /^\+[1-9]\d{7,14}$/;
const REFRESH_TOKEN_BYTES = 32;

/**
 * Reuse grace window (seconds). A token presented again within this long of
 * being consumed/revoked is treated as a benign concurrent or retried refresh
 * (e.g. two app requests racing, or a response lost in transit): it gets a 401
 * but the family is NOT revoked, so the winner's freshly issued successor
 * stays valid. No sibling token is minted — one family never has two live
 * chains. Reuse after the window is replay and revokes the whole family.
 */
export const REFRESH_REUSE_GRACE_SECONDS: number = getPolicy().sessions.refreshReuseGraceS;

/** app_user.status values that may not obtain or renew a session (F12). */
export const BLOCKED_USER_STATUSES: readonly string[] = ['suspended', 'deleted'];

export type AuthMethod = AuthMethodName;

/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

export interface TokenResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  refresh_token: string;
  /** phone_e164 is null for Google-registered accounts; email null for phone-only ones. */
  user: { id: string; role: string; phone_e164: string | null; email: string | null };
}

/** GET /v1/auth/config — what a client may render (RCAB-E8.S15). */
export interface AuthConfigResponse {
  methods: AuthMethod[];
  google: { clientId: string | null };
}

interface SessionUser {
  id: string;
  role: string;
  phone_e164: string | null;
  email: string | null;
  status: string;
}

interface ConsumedRefreshRow {
  user_id: string;
  family_id: string;
  auth_method: AuthMethod;
  role: string;
  phone_e164: string | null;
  email: string | null;
  status: string;
}

const SESSION_USER_COLUMNS = 'id, role, phone_e164, email, status';

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
    @Inject(POLICY) private policy: Policy,
  ) {}

  /** The enabled sign-in methods and the Google client id clients request tokens for. */
  getAuthConfig(): AuthConfigResponse {
    return {
      methods: [...this.policy.auth.enabledMethods],
      google: { clientId: this.google.primaryClientId },
    };
  }

  /** 403 auth_method_disabled unless `method` is in policy auth.enabledMethods. */
  private assertMethodEnabled(method: AuthMethod): void {
    if (!this.policy.auth.enabledMethods.includes(method)) {
      throw new ForbiddenException({
        code: 'auth_method_disabled',
        message: `Sign-in with ${method} is disabled on this server`,
      });
    }
  }

  /**
   * Phone-OTP exchange (Firebase today). Gated by auth.enabledMethods: while
   * `phone` is off (Google-only until launch) it is refused before the token
   * is even verified. The pre-launch OTP provider replaces the verification
   * below; the user lookup/registration and session issue stay.
   */
  async exchangeFirebaseToken(idToken: string): Promise<TokenResponse> {
    this.assertMethodEnabled('phone');
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
    if (decoded.iat !== undefined && nowSec - decoded.iat > getPolicy().sessions.firebaseTokenMaxAgeS) {
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
        RETURNING art.user_id, art.family_id, art.auth_method, au.role, au.phone_e164, au.email, au.status`,
        [tokenHash],
      );

      if (consumed.rows.length === 0) {
        // Unknown, expired, or already used. A known token revoked longer
        // than the grace window ago is a replay: revoke whatever is still live
        // in its family. Within the window it is a concurrent/retried refresh
        // whose winner already holds the successor — reject without revoking.
        await client.query(
          `UPDATE auth_refresh_token SET revoked_at = now()
            WHERE revoked_at IS NULL
              AND family_id = (SELECT family_id FROM auth_refresh_token
                                WHERE token_hash = $1
                                  AND revoked_at IS NOT NULL
                                  AND revoked_at <= now() - make_interval(secs => $2))`,
          [tokenHash, REFRESH_REUSE_GRACE_SECONDS],
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
            { id: row.user_id, role: row.role, phone_e164: row.phone_e164, email: row.email, status: row.status },
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

  /**
   * Possession-based revocation for native logout: holding the refresh token
   * is the credential, so no access token (which may have expired while the
   * app idled) is required. Idempotent and silent — the caller cannot learn
   * whether the token existed.
   */
  async revokePresented(refreshToken: string): Promise<void> {
    await this.pool.query(
      'UPDATE auth_refresh_token SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashRefreshToken(refreshToken)],
    );
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

  /**
   * Google sign-in / registration (RCAB-E8.S15), web and native. Logs in the
   * account whose google_sub matches; otherwise registers a new `client`
   * account holding that sub and the verified email. Never links by email: an
   * existing account with the same email but no (or another) google_sub is
   * not touched — linking stays an explicit, authenticated /google/link.
   * Concurrent first sign-ins for one sub converge on one account.
   */
  async signInWithGoogle(idToken: string): Promise<TokenResponse> {
    this.assertMethodEnabled('google');
    const identity = await this.google.verifyIdToken(idToken);
    const found = await this.findOrRegisterGoogleUser(identity.sub, identity.email);
    this.assertAccountActive(found.status);
    const user = await this.refreshGoogleEmail(found, identity.email);
    return this.issueSession(this.pool, user, 'google', randomUUID());
  }

  /** Legacy POST /v1/auth/google/login — folded into {@link signInWithGoogle}. */
  async loginWithGoogle(googleIdToken: string): Promise<TokenResponse> {
    return this.signInWithGoogle(googleIdToken);
  }

  private async findUserByGoogleSub(db: Queryable, sub: string): Promise<SessionUser | null> {
    const result = await db.query<SessionUser>(
      `SELECT ${SESSION_USER_COLUMNS} FROM app_user WHERE google_sub = $1`,
      [sub],
    );
    return result.rows[0] ?? null;
  }

  private async findOrRegisterGoogleUser(sub: string, email: string): Promise<SessionUser> {
    const existing = await this.findUserByGoogleSub(this.pool, sub);
    if (existing) return existing;

    const client = await this.pool.connect();
    let created: SessionUser | null = null;
    try {
      await client.query('BEGIN');
      const userId = randomUUID();
      // ON CONFLICT: a concurrent first sign-in for the same sub that commits
      // first makes this a no-op (it waits for that commit), so the loser
      // falls through to the login lookup below instead of failing.
      const inserted = await client.query<SessionUser>(
        `INSERT INTO app_user (id, google_sub, email, role, status)
         VALUES ($1, $2, $3, 'client', 'active')
         ON CONFLICT (google_sub) DO NOTHING
         RETURNING ${SESSION_USER_COLUMNS}`,
        [userId, sub, email],
      );
      if (inserted.rows.length > 0) {
        await client.query('INSERT INTO client (user_id) VALUES ($1)', [userId]);
        created = inserted.rows[0];
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code !== PG_UNIQUE_VIOLATION) throw err;
      // Lost a race on a unique key: retry as a login below.
    } finally {
      client.release();
    }
    if (created) return created;

    const winner = await this.findUserByGoogleSub(this.pool, sub);
    if (!winner) {
      throw new ConflictException({ code: 'conflict', message: 'Google sign-in raced; retry' });
    }
    return winner;
  }

  /** Keeps the stored email in step with the address Google just verified. */
  private async refreshGoogleEmail(user: SessionUser, email: string): Promise<SessionUser> {
    if (user.email === email) return user;
    await this.pool.query('UPDATE app_user SET email = $2, updated_at = now() WHERE id = $1', [user.id, email]);
    return { ...user, email };
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
    const expiresAt = new Date(Date.now() + getPolicy().sessions.refreshTokenTtlMs);
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
      user: { id: user.id, role: user.role, phone_e164: user.phone_e164, email: user.email },
    };
  }

  private async findOrCreateUser(firebaseUid: string, phone: string): Promise<SessionUser> {
    const existing = await this.pool.query<SessionUser>(
      `SELECT ${SESSION_USER_COLUMNS} FROM app_user WHERE firebase_uid = $1`,
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
      return { id: userId, role: 'client', phone_e164: phone, email: null, status: 'active' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
