import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { poolMember, rideStop, type SharedRideMember } from '../../db/schema';
import { Constraint, pgConstraintViolation } from '../../db/constraints';
import type { DbExecutor, DrizzleTx } from '../../infra/db/drizzle.module';
import type { OfferStop } from '../dispatch/dispatch.types';

/**
 * Authoritative pool membership (F09 / F15, R08; migration 0016).
 *
 * `pool_member` is the source of truth for who is in a pool; `shared_rides.
 * seat_count` is derived from it by trigger and is never written here. Every
 * write runs inside the caller's transaction, after the caller has locked the
 * `shared_rides` row (`lockPool`) — lock order: shared_rides → pool_member →
 * ride_stops → outbox / idempotency_record (stage-c contract §1.3).
 *
 * Expected conflicts come back as typed results, mapped from constraint names
 * (never from message text); the offending INSERT runs in a savepoint so the
 * caller's transaction stays usable.
 */

export interface PoolLockRow {
  poolId: string;
  poolState: string;
  seatCount: number;
  maxSeats: number;
  dispatchGeneration: number;
  stateVersion: number;
  claimedByDriverId: string | null;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

export interface NewPoolMember {
  poolId: string;
  passengerId: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  quotedFareCents: number | null;
  idempotencyKey: string | null;
}

export type InsertMemberFailure =
  | 'already_member'
  | 'passenger_has_active_pool'
  | 'pool_full'
  | 'pool_closed'
  | 'idempotent_replay';

export type InsertMemberResult =
  | { ok: true; seatCount: number }
  | {
      ok: false;
      reason: InsertMemberFailure;
      /** The pool the passenger already holds a seat in, when one is known. */
      existingPoolId?: string;
    };

export interface SeatLookup {
  poolId: string;
  poolState: string;
  /** True when this passenger opened the pool (earliest member). */
  opened: boolean;
  /** Per-seat price recorded at join (what the passenger was shown), if any. */
  quotedFareCents: number | null;
}

interface SeatDbRow extends Record<string, unknown> {
  pool_id: string;
  pool_state: string;
  opened: boolean;
  quoted_fare_cents: number | string | null;
}

function seatFromDb(r: SeatDbRow): SeatLookup {
  return {
    poolId: r.pool_id,
    poolState: r.pool_state,
    opened: Boolean(r.opened),
    quotedFareCents: r.quoted_fare_cents === null ? null : Number(r.quoted_fare_cents),
  };
}

/** Seat columns + "is this the pool's first member" for one pool_member row `m`. */
const SEAT_SELECT = sql`
  SELECT m.pool_id, s.pool_state, m.quoted_fare_cents,
         NOT EXISTS (
           SELECT 1 FROM pool_member o
            WHERE o.pool_id = m.pool_id
              AND (o.joined_at, o.passenger_id) < (m.joined_at, m.passenger_id)
         ) AS opened
    FROM pool_member m
    JOIN shared_rides s ON s.ride_id = m.pool_id`;

interface LockDbRow extends Record<string, unknown> {
  ride_id: string;
  pool_state: string;
  seat_count: number | string;
  max_seats: number | string;
  dispatch_generation: number | string;
  state_version: number | string;
  claimed_by_driver_id: string | null;
  origin_lat: number | string;
  origin_lng: number | string;
  dest_lat: number | string;
  dest_lng: number | string;
}

interface MemberDbRow extends Record<string, unknown> {
  passenger_id: string;
  origin_lat: number | string;
  origin_lng: number | string;
  dest_lat: number | string;
  dest_lng: number | string;
  joined_at: Date | string;
}

/** Canonical member order: join time, then passenger id (deterministic). */
export const MEMBER_ORDER_SQL = sql.raw('joined_at, passenger_id');

export function memberFromDb(r: MemberDbRow): SharedRideMember {
  return {
    passenger_id: r.passenger_id,
    origin_lat: Number(r.origin_lat),
    origin_lng: Number(r.origin_lng),
    dest_lat: Number(r.dest_lat),
    dest_lng: Number(r.dest_lng),
    joined_at: new Date(r.joined_at).toISOString(),
  };
}

@Injectable()
export class PoolMembershipRepository {
  /** `SELECT … FOR UPDATE` on the pool row — the one serialization point for a pool. */
  async lockPool(tx: DrizzleTx, poolId: string): Promise<PoolLockRow | null> {
    const res = await tx.execute<LockDbRow>(sql`
      SELECT ride_id, pool_state, seat_count, max_seats, dispatch_generation,
             state_version, claimed_by_driver_id, origin_lat, origin_lng, dest_lat, dest_lng
        FROM shared_rides
       WHERE ride_id = ${poolId}
         FOR UPDATE
    `);
    const r = res.rows[0];
    if (!r) return null;
    return {
      poolId: r.ride_id,
      poolState: r.pool_state,
      seatCount: Number(r.seat_count),
      maxSeats: Number(r.max_seats),
      dispatchGeneration: Number(r.dispatch_generation),
      stateVersion: Number(r.state_version),
      claimedByDriverId: r.claimed_by_driver_id ?? null,
      originLat: Number(r.origin_lat),
      originLng: Number(r.origin_lng),
      destLat: Number(r.dest_lat),
      destLng: Number(r.dest_lng),
    };
  }

  /**
   * Seat one passenger. The DB enforces every rule: open pool (trigger),
   * capacity (derived seat_count + CHECK), one membership per pool (PK), one
   * active pool per passenger (partial UNIQUE), one seat per idempotency key.
   * Returns the post-trigger seat_count on success.
   */
  async insertMember(tx: DrizzleTx, m: NewPoolMember): Promise<InsertMemberResult> {
    try {
      await tx.transaction(async (sp) => {
        await sp.insert(poolMember).values({
          poolId: m.poolId,
          passengerId: m.passengerId,
          seats: 1,
          originLat: m.originLat,
          originLng: m.originLng,
          destLat: m.destLat,
          destLng: m.destLng,
          quotedFareCents: m.quotedFareCents,
          idempotencyKey: m.idempotencyKey,
        });
      });
    } catch (err) {
      const v = pgConstraintViolation(err);
      if (!v) throw err;
      switch (v.constraint) {
        case Constraint.PoolNotOpen:
          return { ok: false, reason: 'pool_closed' };
        case Constraint.PoolCapacity:
          return { ok: false, reason: 'pool_full' };
        case Constraint.PoolMemberDuplicate:
        case Constraint.PoolMemberOneActivePool:
        case Constraint.PoolMemberIdempotency:
          return this.classifyDuplicate(tx, m, v.constraint);
        default:
          throw err;
      }
    }
    const res = await tx.execute<{ seat_count: number | string }>(sql`
      SELECT seat_count FROM shared_rides WHERE ride_id = ${m.poolId}
    `);
    return { ok: true, seatCount: Number(res.rows[0]?.seat_count ?? 0) };
  }

  /**
   * More than one unique index can be violated by the same INSERT and Postgres
   * reports only the first it checks, so the outcome is classified from the
   * committed rows (a unique violation waits for the conflicting transaction to
   * commit, so its row is visible to this new statement), in priority order:
   * same idempotency key → replay; same pool → already a member; any other
   * active seat → the passenger is busy. The constraint name is the fallback.
   */
  private async classifyDuplicate(
    tx: DrizzleTx,
    m: NewPoolMember,
    constraint: string,
  ): Promise<InsertMemberResult> {
    const res = await tx.execute<{
      pool_id: string;
      idempotency_key: string | null;
      active: boolean;
    }>(sql`
      SELECT pool_id, idempotency_key, active
        FROM pool_member
       WHERE passenger_id = ${m.passengerId}
         AND (pool_id = ${m.poolId}
              OR active
              OR (${m.idempotencyKey}::text IS NOT NULL AND idempotency_key = ${m.idempotencyKey}))
    `);
    const rows = res.rows;
    const byKey = m.idempotencyKey
      ? rows.find((r) => r.idempotency_key === m.idempotencyKey)
      : undefined;
    if (byKey) return { ok: false, reason: 'idempotent_replay', existingPoolId: byKey.pool_id };
    const samePool = rows.find((r) => r.pool_id === m.poolId);
    // A keyed request whose key did not produce that seat is a DIFFERENT
    // request (T29: different keys → passenger_has_active_pool). Only a keyless
    // duplicate is treated as "already a member" and handed the same pool back.
    if (samePool && (!m.idempotencyKey || !samePool.active)) {
      return { ok: false, reason: 'already_member', existingPoolId: m.poolId };
    }
    const active = rows.find((r) => r.active);
    if (active) {
      return { ok: false, reason: 'passenger_has_active_pool', existingPoolId: active.pool_id };
    }
    if (constraint === Constraint.PoolMemberIdempotency) {
      return { ok: false, reason: 'idempotent_replay' };
    }
    if (constraint === Constraint.PoolMemberDuplicate && !m.idempotencyKey) {
      return { ok: false, reason: 'already_member', existingPoolId: m.poolId };
    }
    return { ok: false, reason: 'passenger_has_active_pool' };
  }

  async listMembers(db: DbExecutor, poolId: string): Promise<SharedRideMember[]> {
    const res = await db.execute<MemberDbRow>(sql`
      SELECT passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, joined_at
        FROM pool_member
       WHERE pool_id = ${poolId}
       ORDER BY ${MEMBER_ORDER_SQL}
    `);
    return res.rows.map(memberFromDb);
  }

  /** The exact seat a shared-create idempotency key produced (no time heuristic). */
  async findByIdempotencyKey(
    db: DbExecutor,
    passengerId: string,
    key: string,
  ): Promise<SeatLookup | null> {
    const res = await db.execute<SeatDbRow>(sql`
      ${SEAT_SELECT}
       WHERE m.passenger_id = ${passengerId}
         AND m.idempotency_key = ${key}
       LIMIT 1
    `);
    const r = res.rows[0];
    return r ? seatFromDb(r) : null;
  }

  /** The passenger's seat in one pool, if any. */
  async findSeat(db: DbExecutor, poolId: string, passengerId: string): Promise<SeatLookup | null> {
    const res = await db.execute<SeatDbRow>(sql`
      ${SEAT_SELECT}
       WHERE m.pool_id = ${poolId}
         AND m.passenger_id = ${passengerId}
       LIMIT 1
    `);
    const r = res.rows[0];
    return r ? seatFromDb(r) : null;
  }

  async findActiveForPassenger(
    db: DbExecutor,
    passengerId: string,
  ): Promise<{ poolId: string; poolState: string } | null> {
    const res = await db.execute<{ pool_id: string; pool_state: string }>(sql`
      SELECT m.pool_id, s.pool_state
        FROM pool_member m
        JOIN shared_rides s ON s.ride_id = m.pool_id
       WHERE m.passenger_id = ${passengerId}
         AND m.active
       LIMIT 1
    `);
    const r = res.rows[0];
    return r ? { poolId: r.pool_id, poolState: r.pool_state } : null;
  }

  /**
   * Persist the itinerary computed at closure. No ON CONFLICT: closure happens
   * once per pool (guarded transition), so an existing stop is a bug and must
   * abort the closing transaction.
   */
  async insertItinerary(tx: DrizzleTx, poolId: string, stops: OfferStop[]): Promise<void> {
    if (stops.length === 0) return;
    await tx.insert(rideStop).values(
      stops.map((s) => ({
        rideId: poolId,
        sequenceIndex: s.sequenceIndex,
        passengerId: s.passengerId,
        type: s.type,
        lat: s.lat,
        lng: s.lng,
      })),
    );
  }
}
