import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { idempotencyRecord } from '../../db/schema';
import type { IdempotencyOperation } from './idempotency';

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

  async complete(scope: IdempotencyScope, resourceId: string, response: unknown): Promise<void> {
    await this.db
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
