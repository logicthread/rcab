import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DbExecutor, type DrizzleDb } from '../../infra/db/drizzle.module';
import { idempotencyRecord } from '../../db/schema';
import { PENDING_RECLAIM_AFTER_MS, type IdempotencyOperation } from './idempotency';

export interface IdempotencyScope {
  principalId: string;
  operation: IdempotencyOperation;
  key: string;
}

export interface IdempotencyRecordRow {
  requestFingerprint: string;
  state: 'pending' | 'completed';
  resourceId: string | null;
  response: unknown;
}

export type IdempotencyClaim =
  | { kind: 'claimed' }
  /**
   * A stale `pending` claim with the same fingerprint was taken over. The side
   * effect may or may not have happened under the previous attempt (which
   * started at `previousAttemptAt`), so the caller must look for its result
   * before repeating it.
   */
  | { kind: 'reclaimed'; previousAttemptAt: Date }
  | { kind: 'existing'; record: IdempotencyRecordRow };

/**
 * Durable `idempotency_record` store for create operations that have no single
 * row of their own (shared create). Usage: `claim` BEFORE the side effect —
 * the primary key `(principal_id, operation, idempotency_key)` lets exactly one
 * concurrent first use win — then `complete` with the replayable response, or
 * `release` if the side effect failed before mutating. F07 / F15 / R05.
 */
@Injectable()
export class IdempotencyRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async claim(scope: IdempotencyScope, requestFingerprint: string): Promise<IdempotencyClaim> {
    const inserted = await this.db
      .insert(idempotencyRecord)
      .values({
        principalId: scope.principalId,
        operation: scope.operation,
        idempotencyKey: scope.key,
        requestFingerprint,
        state: 'pending',
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyRecord.idempotencyKey });
    if (inserted.length > 0) return { kind: 'claimed' };

    const reclaimed = await this.reclaimStale(scope, requestFingerprint);
    if (reclaimed) return { kind: 'reclaimed', previousAttemptAt: reclaimed };

    const existing = await this.find(scope);
    if (!existing) {
      // Released between our INSERT and SELECT — treat as still in flight; the
      // caller's retry will claim it cleanly.
      return {
        kind: 'existing',
        record: { requestFingerprint, state: 'pending', resourceId: null, response: null },
      };
    }
    return { kind: 'existing', record: existing };
  }

  /**
   * Compare-and-swap takeover of an abandoned claim: only a `pending` row with
   * the SAME fingerprint, older than `PENDING_RECLAIM_AFTER_MS`, is restamped.
   * The conditional UPDATE is atomic, so of several concurrent retries exactly
   * one reclaims; the rest see a fresh `created_at` and fall through to
   * 409 in-progress. Returns the previous attempt's start time, or null.
   */
  private async reclaimStale(scope: IdempotencyScope, fingerprint: string): Promise<Date | null> {
    const cutoff = new Date(Date.now() - PENDING_RECLAIM_AFTER_MS);
    const result = await this.db.execute<{ previous_created_at: Date | string }>(sql`
      UPDATE idempotency_record AS r
         SET created_at = now()
        FROM (SELECT created_at, principal_id, operation, idempotency_key
                FROM idempotency_record
               WHERE principal_id = ${scope.principalId}
                 AND operation = ${scope.operation}
                 AND idempotency_key = ${scope.key}
                 FOR UPDATE) AS old
       WHERE r.principal_id = old.principal_id
         AND r.operation = old.operation
         AND r.idempotency_key = old.idempotency_key
         AND r.state = 'pending'
         AND r.request_fingerprint = ${fingerprint}
         AND old.created_at < ${cutoff.toISOString()}::timestamptz
      RETURNING old.created_at AS previous_created_at
    `);
    const prev = result.rows[0]?.previous_created_at;
    return prev === undefined ? null : new Date(prev);
  }

  async complete(scope: IdempotencyScope, resourceId: string, response: unknown): Promise<void> {
    await this.completeIn(this.db, scope, resourceId, response);
  }

  /**
   * `complete` on a caller-supplied executor, so the replayable result commits
   * in the SAME transaction as the side effect it describes (shared create:
   * the pool seat, R08) — a seat can then never exist with its claim pending.
   */
  async completeIn(
    db: DbExecutor,
    scope: IdempotencyScope,
    resourceId: string,
    response: unknown,
  ): Promise<void> {
    await db
      .update(idempotencyRecord)
      .set({ state: 'completed', resourceId, response, completedAt: new Date() })
      .where(this.scopeWhere(scope));
  }

  /** Drop a still-pending claim so the client can retry the same key. */
  async release(scope: IdempotencyScope): Promise<void> {
    await this.db
      .delete(idempotencyRecord)
      .where(and(this.scopeWhere(scope), eq(idempotencyRecord.state, 'pending')));
  }

  async find(scope: IdempotencyScope): Promise<IdempotencyRecordRow | null> {
    const rows = await this.db
      .select()
      .from(idempotencyRecord)
      .where(this.scopeWhere(scope))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      requestFingerprint: r.requestFingerprint,
      state: r.state === 'completed' ? 'completed' : 'pending',
      resourceId: r.resourceId,
      response: r.response,
    };
  }

  private scopeWhere(scope: IdempotencyScope) {
    return and(
      eq(idempotencyRecord.principalId, scope.principalId),
      eq(idempotencyRecord.operation, scope.operation),
      eq(idempotencyRecord.idempotencyKey, scope.key),
    );
  }
}
