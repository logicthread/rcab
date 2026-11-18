import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbExecutor, DrizzleTx } from '../../infra/db/drizzle.module';
import { driverActiveAssignment, driverQueuedAssignment, rides } from '../../db/schema';
import { Constraint, PG_UNIQUE_VIOLATION, pgConstraintViolation } from '../../db/constraints';
import { toRow, type RideRow } from '../rides/ride-row';
import type { TripRef } from './dispatch.types';

/** One row of the driver exclusivity guard (`driver_active_assignment`, 0014). */
export interface AssignmentRow {
  driverId: string;
  trip: TripRef;
  offerId: string | null;
  generation: number;
  assignedAt: Date;
}

/** The pool columns a claim / stop transaction decides on, read under `FOR UPDATE`. */
export interface SharedTripLockRow {
  rideId: string;
  poolState: string;
  seatCount: number;
  maxSeats: number;
  claimedByDriverId: string | null;
  dispatchGeneration: number;
  stateVersion: number;
}

export type DriverEligibility = 'ok' | 'driver_ineligible' | 'vehicle_capacity';

/** Pools a driver may claim: closed to new members, not yet started / terminal. */
export const CLAIMABLE_POOL_STATES = ['closed_full', 'closed_timeout'] as const;

function fromDb(r: typeof driverActiveAssignment.$inferSelect): AssignmentRow {
  const trip: TripRef = r.soloRideId
    ? { kind: 'solo', rideId: r.soloRideId }
    : { kind: 'shared', sharedRideId: r.sharedRideId as string };
  return {
    driverId: r.driverId,
    trip,
    offerId: r.offerId,
    generation: Number(r.dispatchGeneration),
    assignedAt: r.assignedAt,
  };
}

function tripColumn(trip: TripRef) {
  return trip.kind === 'solo'
    ? eq(driverActiveAssignment.soloRideId, trip.rideId)
    : eq(driverActiveAssignment.sharedRideId, trip.sharedRideId);
}

/**
 * THE driver-exclusivity guard (F06 / R06) and the trip-claim SQL for both trip
 * tables. Solo and pool claims both go through `acquire`, so one driver can
 * never hold two active trips across `rides` + `shared_rides`, and one trip can
 * never have two drivers. Stateless: every method runs on the executor it is
 * handed (contract §2.2).
 */
@Injectable()
export class DriverAssignmentRepository {
  /**
   * Insert the guard row inside a savepoint so an expected unique violation
   * leaves the outer transaction usable, and map it to a typed outcome.
   */
  async acquire(
    tx: DrizzleTx,
    p: { driverId: string; trip: TripRef; offerId: string | null; generation: number },
  ): Promise<{ ok: true } | { ok: false; reason: 'driver_busy' | 'trip_taken' }> {
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(driverActiveAssignment).values({
          driverId: p.driverId,
          soloRideId: p.trip.kind === 'solo' ? p.trip.rideId : null,
          sharedRideId: p.trip.kind === 'shared' ? p.trip.sharedRideId : null,
          offerId: p.offerId,
          dispatchGeneration: p.generation,
        });
      });
      return { ok: true };
    } catch (err) {
      const v = pgConstraintViolation(err);
      if (v?.code === PG_UNIQUE_VIOLATION) {
        if (v.constraint === Constraint.AssignmentDriverBusy) {
          return { ok: false, reason: 'driver_busy' };
        }
        if (
          v.constraint === Constraint.AssignmentSoloTaken ||
          v.constraint === Constraint.AssignmentSharedTaken
        ) {
          return { ok: false, reason: 'trip_taken' };
        }
      }
      throw err;
    }
  }

  /**
   * Delete the guard only when it binds THIS driver to THIS trip — a late
   * completion / cancel of trip X never frees the driver's trip Y.
   */
  async release(db: DbExecutor, p: { driverId: string; trip: TripRef }): Promise<boolean> {
    const deleted = await db
      .delete(driverActiveAssignment)
      .where(and(eq(driverActiveAssignment.driverId, p.driverId), tripColumn(p.trip)))
      .returning({ driverId: driverActiveAssignment.driverId });
    return deleted.length > 0;
  }

  async findByDriver(db: DbExecutor, driverId: string): Promise<AssignmentRow | null> {
    const rows = await db
      .select()
      .from(driverActiveAssignment)
      .where(eq(driverActiveAssignment.driverId, driverId))
      .limit(1);
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async findByTrip(db: DbExecutor, trip: TripRef): Promise<AssignmentRow | null> {
    const rows = await db.select().from(driverActiveAssignment).where(tripColumn(trip)).limit(1);
    return rows[0] ? fromDb(rows[0]) : null;
  }

  async listAll(db: DbExecutor): Promise<AssignmentRow[]> {
    const rows = await db.select().from(driverActiveAssignment);
    return rows.map(fromDb);
  }

  /**
   * Queue `trip` as the driver's NEXT ride. Only valid while the driver's active
   * assignment is a solo ride that is `in_progress`; the check is a
   * `FOR SHARE` read of the guard row, so the transaction that ends the active
   * ride (it deletes that row) serializes with this insert and either sees the
   * queued row (and promotes it) or finds the driver idle here. A second queued
   * ride for the same driver is `driver_busy`.
   */
  async queueNext(
    tx: DrizzleTx,
    p: { driverId: string; rideId: string; offerId: string | null; generation: number },
  ): Promise<{ ok: true } | { ok: false; reason: 'driver_busy' | 'trip_taken' }> {
    const active = await tx.execute<{ ok: boolean }>(sql`
      SELECT true AS ok
        FROM driver_active_assignment a
        JOIN rides r ON r.id = a.solo_ride_id
       WHERE a.driver_id = ${p.driverId} AND r.status = 'in_progress'
         FOR SHARE OF a`);
    if (active.rows.length === 0) return { ok: false, reason: 'driver_busy' };
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(driverQueuedAssignment).values({
          driverId: p.driverId,
          soloRideId: p.rideId,
          offerId: p.offerId,
          dispatchGeneration: p.generation,
        });
      });
      return { ok: true };
    } catch (err) {
      const v = pgConstraintViolation(err);
      if (v?.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, reason: v.constraint === Constraint.QueuedDriverFull ? 'driver_busy' : 'trip_taken' };
      }
      throw err;
    }
  }

  /** True when `rideId` is waiting in a driver's next-ride queue (not yet their active trip). */
  async isQueued(db: DbExecutor, rideId: string): Promise<boolean> {
    const rows = await db
      .select({ d: driverQueuedAssignment.driverId })
      .from(driverQueuedAssignment)
      .where(eq(driverQueuedAssignment.soloRideId, rideId))
      .limit(1);
    return rows.length > 0;
  }

  /** Drop a ride from the queue (cancelled while waiting). Returns the driver it was queued for. */
  async dropQueued(db: DbExecutor, rideId: string): Promise<string | null> {
    const del = await db
      .delete(driverQueuedAssignment)
      .where(eq(driverQueuedAssignment.soloRideId, rideId))
      .returning({ driverId: driverQueuedAssignment.driverId });
    return del[0]?.driverId ?? null;
  }

  /**
   * The driver's active trip just ended: move their queued ride (if any) into the
   * exclusivity guard so it becomes their active trip. Returns its ride id.
   * Call inside the transaction that released the previous guard.
   */
  async promoteQueued(tx: DrizzleTx, driverId: string): Promise<string | null> {
    const del = await tx
      .delete(driverQueuedAssignment)
      .where(eq(driverQueuedAssignment.driverId, driverId))
      .returning();
    const q = del[0];
    if (!q) return null;
    await tx.insert(driverActiveAssignment).values({
      driverId,
      soloRideId: q.soloRideId,
      sharedRideId: null,
      offerId: q.offerId,
      dispatchGeneration: q.dispatchGeneration,
    });
    return q.soloRideId;
  }

  /** Lock-order step 1 for a solo trip. */
  async lockSoloTrip(tx: DrizzleTx, rideId: string): Promise<RideRow | null> {
    const rows = await tx.select().from(rides).where(eq(rides.id, rideId)).for('update').limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** Lock-order step 1 for a shared trip. */
  async lockSharedTrip(tx: DrizzleTx, poolId: string): Promise<SharedTripLockRow | null> {
    const res = await tx.execute<{
      ride_id: string;
      pool_state: string;
      seat_count: number | string;
      max_seats: number | string;
      claimed_by_driver_id: string | null;
      dispatch_generation: number | string;
      state_version: number | string;
    }>(sql`
      SELECT ride_id, pool_state, seat_count, max_seats, claimed_by_driver_id,
             dispatch_generation, state_version
        FROM shared_rides WHERE ride_id = ${poolId} FOR UPDATE`);
    const r = res.rows[0];
    if (!r) return null;
    return {
      rideId: r.ride_id,
      poolState: r.pool_state,
      seatCount: Number(r.seat_count),
      maxSeats: Number(r.max_seats),
      claimedByDriverId: r.claimed_by_driver_id,
      dispatchGeneration: Number(r.dispatch_generation),
      stateVersion: Number(r.state_version),
    };
  }

  /**
   * `requested → accepted` for the driver. The caller holds the row lock and has
   * validated state + generation; the WHERE is a belt-and-braces guard, so a
   * zero-row result is a bug and throws (rolling the claim back).
   */
  async claimSoloRow(
    tx: DrizzleTx,
    rideId: string,
    driverId: string,
    generation: number,
  ): Promise<RideRow> {
    const updated = await tx
      .update(rides)
      .set({
        status: 'accepted',
        driverId,
        acceptedAt: sql`now()`,
        updatedAt: sql`now()`,
        dispatchGeneration: sql`GREATEST(${rides.dispatchGeneration}, ${generation}::int)`,
      })
      .where(and(eq(rides.id, rideId), eq(rides.status, 'requested'), isNull(rides.driverId)))
      .returning();
    if (!updated[0]) throw new Error(`claimSoloRow: ride ${rideId} is not claimable`);
    return toRow(updated[0]);
  }

  async claimSharedRow(
    tx: DrizzleTx,
    poolId: string,
    driverId: string,
    generation: number,
  ): Promise<void> {
    const res = await tx.execute(sql`
      UPDATE shared_rides
         SET claimed_by_driver_id = ${driverId}, claimed_at = now(), updated_at = now()
       WHERE ride_id = ${poolId} AND claimed_by_driver_id IS NULL
         AND pool_state IN ('closed_full', 'closed_timeout')
         AND dispatch_generation = ${generation}
       RETURNING ride_id`);
    if (res.rows.length === 0) throw new Error(`claimSharedRow: pool ${poolId} is not claimable`);
  }

  /**
   * Hard-fail of an unclaimed, dispatched pool at this generation → `aborted`.
   * The 0016 trigger releases every member in the same statement.
   */
  async abortUnclaimedPool(tx: DrizzleTx, poolId: string, generation: number): Promise<boolean> {
    const res = await tx.execute(sql`
      UPDATE shared_rides SET pool_state = 'aborted', updated_at = now()
       WHERE ride_id = ${poolId} AND claimed_by_driver_id IS NULL
         AND pool_state IN ('closed_full', 'closed_timeout')
         AND dispatch_generation = ${generation}
       RETURNING ride_id`);
    return res.rows.length > 0;
  }

  /**
   * Account + vehicle eligibility at the assignment decision: an active
   * `app_user` with role driver and a `driver` row, and an active vehicle with
   * `seats ≥ seatsNeeded`.
   */
  async driverEligibility(
    db: DbExecutor,
    driverId: string,
    seatsNeeded: number,
  ): Promise<DriverEligibility> {
    const res = await db.execute<{ eligible: boolean; max_seats: number | string | null }>(sql`
      SELECT (u.status = 'active' AND u.role = 'driver' AND d.user_id IS NOT NULL) AS eligible,
             (SELECT max(v.seats) FROM vehicle v WHERE v.driver_id = u.id AND v.active) AS max_seats
        FROM app_user u LEFT JOIN driver d ON d.user_id = u.id
       WHERE u.id = ${driverId}`);
    const r = res.rows[0];
    if (!r || !r.eligible) return 'driver_ineligible';
    return Number(r.max_seats ?? 0) >= seatsNeeded ? 'ok' : 'vehicle_capacity';
  }
}
