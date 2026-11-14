import { Injectable, Inject } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { rides } from '../../db/schema';
import { DriverAssignmentRepository } from '../dispatch/assignment.repository';
import { DispatchOfferRepository } from '../dispatch/offer.repository';
import { IdempotencyOperation } from './idempotency';
import { enqueueOutbox } from '../outbox/outbox.writer';
import { OutboxTopic } from '../outbox/outbox.types';
import { toRow, type RideRow } from './ride-row';
import { getPolicy } from '../../config/policy/policy';
import { recordDispatchOutcome, recordRideTransition } from '../../metrics';
import { Constraint, PG_UNIQUE_VIOLATION, pgConstraintViolation } from '../../db/constraints';

export type { RideRow } from './ride-row';

/** A live offer a ride-state change revoked; its driver is told after commit. */
export interface RevokedOffer {
  offerId: string;
  driverId: string;
}

/** The idempotency operations that persist as a `rides` row. */
export type RideIdempotencyOperation =
  | typeof IdempotencyOperation.Solo
  | typeof IdempotencyOperation.Scheduled;

function operationForType(type: string): RideIdempotencyOperation {
  return type === 'scheduled' ? IdempotencyOperation.Scheduled : IdempotencyOperation.Solo;
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
  | { ok: true; row: RideRow; revokedOffers: RevokedOffer[] }
  | {
      ok: false;
      reason: 'not_found' | 'not_owner' | 'invalid_transition' | 'no_show_too_early';
    };

// Which live states each actor may cancel from. A plain cancel lands on
// `cancelled`; a driver no-show (from `arrived` only) lands on `no_show`. The
// client may bail any time before the trip starts; the driver may bail any time
// before completion (and is only ever the bound driver, so requested/dispatching
// — which have no driver_id — fall out via the ownership check). RCAB-E4.S8.
// Code-fixed policy knobs rides.clientCancellableFrom / rides.driverCancellableFrom.
const CLIENT_CANCELLABLE: ReadonlySet<string> = new Set(getPolicy().rides.clientCancellableFrom);
const DRIVER_CANCELLABLE: ReadonlySet<string> = new Set(getPolicy().rides.driverCancellableFrom);

// Each forward target state stamps exactly one timestamp column. `accepted` is
// stamped by claimSolo (0007); the rest land here on transition.
// Statuses after which the driver no longer holds the trip (guard released).
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'no_show']);

const TIMESTAMP_FOR_STATUS: Record<
  string,
  'enRouteAt' | 'arrivedAt' | 'startedAt' | 'completedAt' | undefined
> = {
  en_route: 'enRouteAt',
  arrived: 'arrivedAt',
  in_progress: 'startedAt',
  completed: 'completedAt',
};

/** Statuses of a ride that is still live (not terminal). */
export const LIVE_RIDE_STATUSES = [
  'requested',
  'dispatching',
  'accepted',
  'en_route',
  'arrived',
  'in_progress',
] as const;

/**
 * The passenger already has a live immediate ride; raised when the
 * `rides_one_live_normal_per_passenger_uq` backstop (0019) rejects an insert
 * that raced past the controller's pre-check.
 */
export class PassengerHasActiveRideError extends Error {
  constructor() {
    super('passenger already has a live normal ride');
  }
}

@Injectable()
export class RidesRepository {
  // Stateless SQL helpers (they run on the transaction they are handed); held
  // directly rather than injected so RidesModule does not depend on dispatch.
  private readonly assignments = new DriverAssignmentRepository();
  private readonly offers = new DispatchOfferRepository();

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Insert a solo/scheduled ride in `requested` state. Idempotency is scoped to
   * `(passenger, operation, key)` — the `rides_idempotency_scope_uq` constraint
   * is the durable dedup backstop (F07 / migration 0013): on conflict we return
   * the caller's OWN existing row plus its stored fingerprint, so the caller can
   * replay it or reject a mismatched intent. Another passenger's identical key
   * never conflicts. `created` is false on a replay.
   */
  async create(params: {
    passengerId: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    fareCents: number;
    idempotencyKey: string;
    type?: string;
    scheduledFor?: Date | null;
    /** Defaults from `type` (scheduled → ride.create.scheduled, else solo). */
    idempotencyOperation?: RideIdempotencyOperation;
    requestFingerprint?: string | null;
  }): Promise<{ row: RideRow; created: boolean; requestFingerprint: string | null }> {
    const type = params.type ?? 'normal';
    const operation = params.idempotencyOperation ?? operationForType(type);
    const fingerprint = params.requestFingerprint ?? null;
    const scheduled = type === 'scheduled';

    // ONE transaction: the ride row and the work intent that makes it
    // dispatchable commit together or not at all (F08 / R07). A crash anywhere
    // after COMMIT leaves a durable outbox row for the relay (and, if the
    // queue is later lost, for the reconciler); a crash before it leaves
    // neither, so a retry simply creates both. A replay (scope conflict) writes
    // no new intent: the original commit already carried it.
    let inserted;
    try {
      inserted = await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(rides)
          .values({
            passengerId: params.passengerId,
            originLat: params.originLat,
            originLng: params.originLng,
            destLat: params.destLat,
            destLng: params.destLng,
            fareCents: params.fareCents,
            status: 'requested',
            type,
            scheduledFor: params.scheduledFor ?? null,
            idempotencyKey: params.idempotencyKey,
            idempotencyOperation: operation,
            requestFingerprint: fingerprint,
            // A normal ride is dispatchable at once (generation 1). A scheduled
            // ride stays at generation 0 until its wake (T-lead) moves it to 1.
            dispatchGeneration: scheduled ? 0 : 1,
          })
          .onConflictDoNothing({
            target: [rides.passengerId, rides.idempotencyOperation, rides.idempotencyKey],
          })
          .returning();
        const row = rows[0];
        if (!row) return null;
        if (scheduled) {
          if (!params.scheduledFor) throw new Error('scheduled ride requires scheduledFor');
          await enqueueOutbox(tx, {
            topic: OutboxTopic.RideWakeSchedule,
            aggregateType: 'ride',
            aggregateId: row.id,
            generation: 1,
            payload: { scheduledFor: params.scheduledFor.toISOString() },
          });
        } else {
          await enqueueOutbox(tx, {
            topic: OutboxTopic.RideDispatchRequested,
            aggregateType: 'ride',
            aggregateId: row.id,
            generation: 1,
            payload: { rideId: row.id },
          });
        }
        return row;
      });
    } catch (err) {
      const v = pgConstraintViolation(err);
      if (v?.code === PG_UNIQUE_VIOLATION && v.constraint === Constraint.RidePassengerHasLiveRide) {
        // A concurrent retry of THIS request can trip the one-live-ride index
        // before the idempotency arbiter (Postgres checks non-arbiter unique
        // indexes too): if our own scope row exists, it is a replay.
        const own = await this.findByIdempotencyScope(
          params.passengerId,
          operation,
          params.idempotencyKey,
        );
        if (own) return { ...own, created: false };
        throw new PassengerHasActiveRideError();
      }
      throw err;
    }

    if (inserted) {
      // Counted once, after the ride + its intent committed (replays insert nothing).
      recordRideTransition('none', 'requested');
      return { row: toRow(inserted), created: true, requestFingerprint: fingerprint };
    }
    const existing = await this.findByIdempotencyScope(
      params.passengerId,
      operation,
      params.idempotencyKey,
    );
    if (!existing) {
      // The conflicting row vanished between INSERT and SELECT (deleted user
      // cascade) — surface it rather than pretend a ride exists.
      throw new Error('idempotency conflict without a matching ride');
    }
    return { ...existing, created: false };
  }

  /** The passenger's live immediate (normal) ride, if any (newest first). */
  async findLiveNormalRide(passengerId: string): Promise<RideRow | null> {
    const rows = await this.db
      .select()
      .from(rides)
      .where(
        and(
          eq(rides.passengerId, passengerId),
          eq(rides.type, 'normal'),
          inArray(rides.status, [...LIVE_RIDE_STATUSES]),
        ),
      )
      .orderBy(desc(rides.createdAt))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findById(id: string): Promise<RideRow | null> {
    const rows = await this.db.select().from(rides).where(eq(rides.id, id)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * The caller's own ride for an idempotency scope, with its stored request
   * fingerprint (`null` for legacy pre-0013 rows). There is deliberately no
   * global by-key lookup: a key is meaningless outside its owner + operation.
   */
  async findByIdempotencyScope(
    passengerId: string,
    operation: RideIdempotencyOperation,
    key: string,
  ): Promise<{ row: RideRow; requestFingerprint: string | null } | null> {
    const rows = await this.db
      .select()
      .from(rides)
      .where(
        and(
          eq(rides.passengerId, passengerId),
          eq(rides.idempotencyOperation, operation),
          eq(rides.idempotencyKey, key),
        ),
      )
      .limit(1);
    return rows[0] ? { row: toRow(rows[0]), requestFingerprint: rows[0].requestFingerprint } : null;
  }

  /**
   * Direct (offer-less) guarded assignment of a `requested` solo ride to a
   * driver — the operator / fixture seam. Same transaction shape as an offer
   * accept: lock the ride, take the driver-exclusivity guard (F06), bind the
   * row, revoke any live offers. Returns null when the ride is not claimable,
   * the driver already holds an active trip, or the ride already has a driver.
   */
  async claimSolo(rideId: string, driverId: string): Promise<RideRow | null> {
    const claimed = await this.db.transaction(async (tx) => {
      const ride = await this.assignments.lockSoloTrip(tx, rideId);
      if (!ride || ride.status !== 'requested' || ride.driverId) return null;
      const generation = Math.max(ride.dispatchGeneration, 1);
      const trip = { kind: 'solo', rideId } as const;
      const guard = await this.assignments.acquire(tx, {
        driverId,
        trip,
        offerId: null,
        generation,
      });
      if (!guard.ok) return null;
      const row = await this.assignments.claimSoloRow(tx, rideId, driverId, generation);
      await this.offers.revokeLiveForTrip(tx, trip);
      return row;
    });
    if (claimed) {
      recordRideTransition('requested', 'accepted');
      recordDispatchOutcome('assigned', 'solo');
    }
    return claimed;
  }

  /**
   * Terminal transition when dispatch exhausts all waves with no acceptance.
   * One transaction: lock the ride, require `requested`, unassigned and — when
   * the timer carries one — the same dispatch generation (a legacy job without
   * a generation means "current"), then mark `no_driver` and revoke every live
   * offer. A ride claimed or cancelled in the same instant is left untouched.
   */
  async markNoDriver(
    rideId: string,
    generation?: number,
  ): Promise<{ row: RideRow; revokedOffers: RevokedOffer[] } | null> {
    const failed = await this.db.transaction(async (tx) => {
      const ride = await this.assignments.lockSoloTrip(tx, rideId);
      if (!ride || ride.status !== 'requested' || ride.driverId) return null;
      if (generation !== undefined && generation !== ride.dispatchGeneration) return null;
      const updated = await tx
        .update(rides)
        .set({ status: 'no_driver', updatedAt: sql`now()` })
        .where(eq(rides.id, rideId))
        .returning();
      const revokedOffers = await this.offers.revokeLiveForTrip(tx, { kind: 'solo', rideId });
      return { row: toRow(updated[0]), revokedOffers };
    });
    if (failed) {
      recordRideTransition('requested', 'no_driver');
      recordDispatchOutcome('no_driver', 'solo');
    }
    return failed;
  }

  /**
   * Apply one guarded lifecycle transition for the bound driver. Wraps a
   * `SELECT … FOR UPDATE` of the ride row inside a transaction (per
   * [[module-rides]] concurrency rule) so a transition can never race a
   * concurrent one. Classifies failure before writing: a missing row is
   * `not_found`, a caller who is not the bound driver is `not_owner`, and a
   * `fromStatus` that no longer matches the live row is `invalid_transition`
   * (out-of-order / already advanced). On success it stamps the timestamp
   * column for `toStatus`. Reaching `completed` releases the driver's
   * assignment guard in the same transaction (F06). RCAB-E4.S6.
   */
  async transition(
    rideId: string,
    driverId: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<RideTransitionResult> {
    const result = await this.db.transaction(async (tx): Promise<RideTransitionResult> => {
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
      if (TERMINAL_STATUSES.has(toStatus)) {
        await this.assignments.release(tx, { driverId, trip: { kind: 'solo', rideId } });
      }
      return { ok: true, row: toRow(updated[0]) };
    });
    if (result.ok) recordRideTransition(fromStatus, toStatus);
    return result;
  }

  /**
   * Guarded cancellation / no-show. Like `transition`, runs a
   * `SELECT … FOR UPDATE` inside a transaction so it can never race a forward
   * step, a concurrent cancel or an offer accept (the accept locks the same row
   * first — exactly one of them commits its outcome, T21). Classifies failure
   * before writing: missing row → `not_found`; a caller who is not the bound
   * party → `not_owner`; a current state that is not cancellable for the actor
   * → `invalid_transition`. A no-show is only valid from `arrived` and only once
   * `now − arrived_at ≥ noShowWaitMs` (else `no_show_too_early`). On success it
   * stamps `cancelled_at` + records `cancelled_by` / `cancel_reason`, revokes
   * every live offer and releases the bound driver's guard in the same
   * transaction. No fee is computed (Phase-0). RCAB-E4.S8.
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
    let fromStatus = '';
    let wasDispatching = false;
    const result = await this.db.transaction(async (tx): Promise<RideCancelResult> => {
      const rows = await tx.select().from(rides).where(eq(rides.id, rideId)).for('update').limit(1);
      const current = rows[0];
      if (!current) return { ok: false, reason: 'not_found' };

      const owns =
        actor === 'client' ? current.passengerId === actorId : current.driverId === actorId;
      if (!owns) return { ok: false, reason: 'not_owner' };

      const now = new Date();
      fromStatus = current.status;
      // A scheduled ride is generation 0 until its wake: not yet in dispatch.
      wasDispatching = current.dispatchGeneration >= 1;
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
      const trip = { kind: 'solo', rideId } as const;
      const revokedOffers = await this.offers.revokeLiveForTrip(tx, trip);
      if (current.driverId) {
        await this.assignments.release(tx, { driverId: current.driverId, trip });
      }
      return { ok: true, row: toRow(updated[0]), revokedOffers };
    });
    if (result.ok) {
      recordRideTransition(fromStatus, result.row.status);
      // Cancelled while still unassigned: a dispatch generation ended by the rider.
      if (fromStatus === 'requested' && wasDispatching) recordDispatchOutcome('cancelled', 'solo');
    }
    return result;
  }
}
