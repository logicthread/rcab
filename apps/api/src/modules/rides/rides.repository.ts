import { Injectable, Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { rides } from '../../db/schema';

export interface RideRow {
  id: string;
  passengerId: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  fareCents: number;
  status: string;
  idempotencyKey: string;
  driverId: string | null;
  acceptedAt: Date | null;
  enRouteAt: Date | null;
  arrivedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancelReason: string | null;
}

/**
 * Result of a guarded lifecycle transition. The three failure reasons map to
 * HTTP 404 / 403 / 409 at the controller. RCAB-E4.S6.
 */
export type RideTransitionResult =
  | { ok: true; row: RideRow }
  | { ok: false; reason: 'not_found' | 'not_owner' | 'invalid_transition' };

/**
 * Result of a guarded cancellation. `no_show_too_early` is the extra reason for
 * a no-show reported before the 5-minute wait has elapsed (→ HTTP 409). RCAB-E4.S8.
 */
export type RideCancelResult =
  | { ok: true; row: RideRow }
  | {
      ok: false;
      reason: 'not_found' | 'not_owner' | 'invalid_transition' | 'no_show_too_early';
    };

// Which live states each actor may cancel from. A plain cancel lands on
// `cancelled`; a driver no-show (from `arrived` only) lands on `no_show`. The
// client may bail any time before the trip starts; the driver may bail any time
// before completion (and is only ever the bound driver, so requested/dispatching
// — which have no driver_id — fall out via the ownership check). RCAB-E4.S8.
const CLIENT_CANCELLABLE: ReadonlySet<string> = new Set([
  'requested',
  'dispatching',
  'accepted',
  'en_route',
  'arrived',
]);
const DRIVER_CANCELLABLE: ReadonlySet<string> = new Set([
  'requested',
  'dispatching',
  'accepted',
  'en_route',
  'arrived',
  'in_progress',
]);

// Each forward target state stamps exactly one timestamp column. `accepted` is
// stamped by claimSolo (0007); the rest land here on transition.
const TIMESTAMP_FOR_STATUS: Record<
  string,
  'enRouteAt' | 'arrivedAt' | 'startedAt' | 'completedAt' | undefined
> = {
  en_route: 'enRouteAt',
  arrived: 'arrivedAt',
  in_progress: 'startedAt',
  completed: 'completedAt',
};

function toRow(r: typeof rides.$inferSelect): RideRow {
  return {
    id: r.id,
    passengerId: r.passengerId,
    originLat: Number(r.originLat),
    originLng: Number(r.originLng),
    destLat: Number(r.destLat),
    destLng: Number(r.destLng),
    fareCents: Number(r.fareCents),
    status: r.status,
    idempotencyKey: r.idempotencyKey,
    driverId: r.driverId,
    acceptedAt: r.acceptedAt,
    enRouteAt: r.enRouteAt,
    arrivedAt: r.arrivedAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    cancelledAt: r.cancelledAt,
    cancelledBy: r.cancelledBy,
    cancelReason: r.cancelReason,
  };
}

@Injectable()
export class RidesRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Insert a solo ride in `requested` state. The `idempotency_key` UNIQUE
   * constraint is the durable dedup backstop: on conflict we return the existing
   * row instead of inserting a duplicate. `created` is false on a replay.
   */
  async create(params: {
    passengerId: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    fareCents: number;
    idempotencyKey: string;
  }): Promise<{ row: RideRow; created: boolean }> {
    const inserted = await this.db
      .insert(rides)
      .values({
        passengerId: params.passengerId,
        originLat: params.originLat,
        originLng: params.originLng,
        destLat: params.destLat,
        destLng: params.destLng,
        fareCents: params.fareCents,
        status: 'requested',
        idempotencyKey: params.idempotencyKey,
      })
      .onConflictDoNothing({ target: rides.idempotencyKey })
      .returning();

    if (inserted.length > 0) {
      return { row: toRow(inserted[0]), created: true };
    }
    const existing = await this.findByIdempotencyKey(params.idempotencyKey);
    // The conflict guarantees a row exists; the non-null assertion is safe.
    return { row: existing!, created: false };
  }

  async findById(id: string): Promise<RideRow | null> {
    const rows = await this.db.select().from(rides).where(eq(rides.id, id)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<RideRow | null> {
    const rows = await this.db.select().from(rides).where(eq(rides.idempotencyKey, key)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * First-accept-wins solo claim. Conditional on `status='requested'`, so it is
   * atomic against a concurrent claim (only one UPDATE can match the row while
   * it is requested). Returns the bound row, or null if the ride was already
   * claimed / cancelled / gone (0 rows affected). RCAB-E4.S4.
   */
  async claimSolo(rideId: string, driverId: string, acceptedAt: Date): Promise<RideRow | null> {
    const updated = await this.db
      .update(rides)
      .set({ status: 'accepted', driverId, acceptedAt, updatedAt: new Date() })
      .where(and(eq(rides.id, rideId), eq(rides.status, 'requested')))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  }

  /**
   * Terminal transition when dispatch exhausts all waves with no acceptance.
   * Guarded by `status='requested'` so it never clobbers a ride that got
   * claimed in the same instant the hard-fail timer fired. RCAB-E4.S4.
   */
  async markNoDriver(rideId: string): Promise<RideRow | null> {
    const updated = await this.db
      .update(rides)
      .set({ status: 'no_driver', updatedAt: new Date() })
      .where(and(eq(rides.id, rideId), eq(rides.status, 'requested')))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  }

  /**
   * Apply one guarded lifecycle transition for the bound driver. Wraps a
   * `SELECT … FOR UPDATE` of the ride row inside a transaction (per
   * [[module-rides]] concurrency rule) so a transition can never race a
   * concurrent one. Classifies failure before writing: a missing row is
   * `not_found`, a caller who is not the bound driver is `not_owner`, and a
   * `fromStatus` that no longer matches the live row is `invalid_transition`
   * (out-of-order / already advanced). On success it stamps the timestamp
   * column for `toStatus`. RCAB-E4.S6.
   */
  async transition(
    rideId: string,
    driverId: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<RideTransitionResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(rides).where(eq(rides.id, rideId)).for('update').limit(1);
      const current = rows[0];
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.driverId !== driverId) return { ok: false, reason: 'not_owner' };
      if (current.status !== fromStatus) return { ok: false, reason: 'invalid_transition' };

      const now = new Date();
      const patch: Partial<typeof rides.$inferInsert> = { status: toStatus, updatedAt: now };
      const tsField = TIMESTAMP_FOR_STATUS[toStatus];
      if (tsField) patch[tsField] = now;

      const updated = await tx.update(rides).set(patch).where(eq(rides.id, rideId)).returning();
      return { ok: true, row: toRow(updated[0]) };
    });
  }

  /**
   * Guarded cancellation / no-show. Like `transition`, runs a
   * `SELECT … FOR UPDATE` inside a transaction so it can never race a forward
   * step or a concurrent cancel. Classifies failure before writing: missing row
   * → `not_found`; a caller who is not the bound party → `not_owner`; a current
   * state that is not cancellable for the actor → `invalid_transition`. A no-show
   * is only valid from `arrived` and only once `now − arrived_at ≥ noShowWaitMs`
   * (else `no_show_too_early`). On success it stamps `cancelled_at` + records
   * `cancelled_by` / `cancel_reason`. No fee is computed (Phase-0). RCAB-E4.S8.
   */
  async cancel(params: {
    rideId: string;
    actor: 'client' | 'driver';
    actorId: string;
    isNoShow: boolean;
    reason: string | null;
    noShowWaitMs: number;
  }): Promise<RideCancelResult> {
    const { rideId, actor, actorId, isNoShow, reason, noShowWaitMs } = params;
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(rides).where(eq(rides.id, rideId)).for('update').limit(1);
      const current = rows[0];
      if (!current) return { ok: false, reason: 'not_found' };

      const owns =
        actor === 'client' ? current.passengerId === actorId : current.driverId === actorId;
      if (!owns) return { ok: false, reason: 'not_owner' };

      const now = new Date();
      let toStatus: 'cancelled' | 'no_show';
      if (isNoShow) {
        // No-show is driver-only (the controller enforces the role) and only
        // ever from `arrived`, after the wait elapses.
        if (current.status !== 'arrived') return { ok: false, reason: 'invalid_transition' };
        const arrivedMs = current.arrivedAt?.getTime();
        if (arrivedMs === undefined || now.getTime() - arrivedMs < noShowWaitMs) {
          return { ok: false, reason: 'no_show_too_early' };
        }
        toStatus = 'no_show';
      } else {
        const cancellable = actor === 'client' ? CLIENT_CANCELLABLE : DRIVER_CANCELLABLE;
        if (!cancellable.has(current.status)) {
          return { ok: false, reason: 'invalid_transition' };
        }
        toStatus = 'cancelled';
      }

      const updated = await tx
        .update(rides)
        .set({
          status: toStatus,
          cancelledAt: now,
          cancelledBy: actor,
          cancelReason: reason,
          updatedAt: now,
        })
        .where(eq(rides.id, rideId))
        .returning();
      return { ok: true, row: toRow(updated[0]) };
    });
  }
}
