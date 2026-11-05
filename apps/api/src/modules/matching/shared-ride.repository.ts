import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DbExecutor, type DrizzleDb } from '../../infra/db/drizzle.module';
import { sharedRide, type SharedRideMember } from '../../db/schema';
import { memberFromDb } from './pool-membership.repository';

export type { SharedRideMember } from '../../db/schema';

export interface SharedRideRow {
  rideId: string;
  /** Derived from pool_member by trigger (0016) — read-only for the app. */
  seatCount: number;
  maxSeats: number;
  poolState: string;
  poolClosedAt: Date | null;
  detourBudgetM: number;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  /** Derived from pool_member (ORDER BY joined_at, passenger_id); the jsonb column is deprecated. */
  members: SharedRideMember[];
  claimedByDriverId: string | null;
  claimedAt: Date | null;
  /** 0014: generation every offer/dispatch job for this pool must match. */
  dispatchGeneration: number;
  /** 0016: trigger-bumped on every UPDATE; Redis projections carry it. */
  stateVersion: number;
}

interface CandidateDbRow extends Record<string, unknown> {
  ride_id: string;
  seat_count: number | string;
  max_seats: number | string;
  pool_state: string;
  pool_closed_at: Date | null;
  detour_budget_m: number | string;
  origin_lat: number | string;
  origin_lng: number | string;
  dest_lat: number | string;
  dest_lng: number | string;
  members: unknown;
  claimed_by_driver_id: string | null;
  claimed_at: Date | null;
  dispatch_generation: number | string;
  state_version: number | string;
}

function parseMembers(raw: unknown): SharedRideMember[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return (list as Parameters<typeof memberFromDb>[0][]).map(memberFromDb);
}

function rowFromDb(r: CandidateDbRow): SharedRideRow {
  return {
    rideId: r.ride_id,
    seatCount: Number(r.seat_count),
    maxSeats: Number(r.max_seats),
    poolState: r.pool_state,
    poolClosedAt: r.pool_closed_at ? new Date(r.pool_closed_at) : null,
    detourBudgetM: Number(r.detour_budget_m),
    originLat: Number(r.origin_lat),
    originLng: Number(r.origin_lng),
    destLat: Number(r.dest_lat),
    destLng: Number(r.dest_lng),
    members: parseMembers(r.members),
    claimedByDriverId: r.claimed_by_driver_id ?? null,
    claimedAt: r.claimed_at ? new Date(r.claimed_at) : null,
    dispatchGeneration: Number(r.dispatch_generation),
    stateVersion: Number(r.state_version),
  };
}

/**
 * Pool row + members derived from `pool_member` (authoritative since 0016).
 * Every column the app reads about a pool comes through this projection, so
 * `SharedRideRow.members` keeps its shape for dispatch / lifecycle readers.
 */
const POOL_SELECT = sql`
  SELECT s.ride_id, s.seat_count, s.max_seats, s.pool_state, s.pool_closed_at,
         s.detour_budget_m, s.origin_lat, s.origin_lng, s.dest_lat, s.dest_lng,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'passenger_id', m.passenger_id,
                    'origin_lat',   m.origin_lat,
                    'origin_lng',   m.origin_lng,
                    'dest_lat',     m.dest_lat,
                    'dest_lng',     m.dest_lng,
                    'joined_at',    m.joined_at)
                  ORDER BY m.joined_at, m.passenger_id)
             FROM pool_member m
            WHERE m.pool_id = s.ride_id
         ), '[]'::json) AS members,
         s.claimed_by_driver_id, s.claimed_at,
         s.dispatch_generation, s.state_version
    FROM shared_rides s`;

@Injectable()
export class SharedRideRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Advisory candidate discovery (no lock). Eligibility — open state and free
   * capacity — is re-validated under the pool row lock when joining.
   */
  async findCandidates(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<SharedRideRow[]> {
    const result = await this.db.execute<CandidateDbRow>(sql`
      ${POOL_SELECT}
      WHERE  ST_DWithin(
               s.origin_centroid,
               ST_SetSRID(ST_MakePoint(${originLng}, ${originLat}), 4326)::geography,
               1500
             )
        AND  ST_DWithin(
               s.dest_centroid,
               ST_SetSRID(ST_MakePoint(${destLng}, ${destLat}), 4326)::geography,
               1500
             )
        AND  s.pool_state = 'open'
        AND  s.seat_count < s.max_seats
    `);

    return result.rows.map(rowFromDb);
  }

  async findById(rideId: string, db: DbExecutor = this.db): Promise<SharedRideRow | null> {
    const result = await db.execute<CandidateDbRow>(sql`
      ${POOL_SELECT}
      WHERE  s.ride_id = ${rideId}
      LIMIT  1
    `);
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  /** Every non-terminal pool id (projection rebuild). */
  async listNonTerminalIds(): Promise<string[]> {
    const result = await this.db.execute<{ ride_id: string }>(sql`
      SELECT ride_id FROM shared_rides
       WHERE pool_state IN ('open', 'closed_full', 'closed_timeout', 'closed_started')
    `);
    return result.rows.map((r) => r.ride_id);
  }

  /**
   * Create an open, empty pool inside the caller's transaction. seat_count
   * starts at 0 and is derived from pool_member by trigger; the planned close
   * instant uses the DB clock. The deprecated jsonb `members` stays '[]'.
   */
  async insertOpenPool(
    tx: DbExecutor,
    p: {
      rideId: string;
      originLat: number;
      originLng: number;
      destLat: number;
      destLng: number;
      maxSeats: number;
      detourBudgetM: number;
      timeoutMs: number;
    },
  ): Promise<{ poolClosedAt: Date }> {
    const res = await tx.execute<{ pool_closed_at: Date | string }>(sql`
      INSERT INTO shared_rides
        (ride_id, seat_count, max_seats, pool_state, pool_closed_at, detour_budget_m,
         origin_lat, origin_lng, dest_lat, dest_lng, members, dispatch_generation)
      VALUES
        (${p.rideId}, 0, ${p.maxSeats}, 'open',
         now() + make_interval(secs => ${p.timeoutMs}::float8 / 1000.0),
         ${p.detourBudgetM}, ${p.originLat}, ${p.originLng}, ${p.destLat}, ${p.destLng},
         '[]'::jsonb, 0)
      RETURNING pool_closed_at
    `);
    return { poolClosedAt: new Date(res.rows[0].pool_closed_at) };
  }

  /**
   * The one legal way out of 'open' into a dispatchable state: guarded on
   * `pool_state = 'open'` (so a stale timeout or a second filler is a no-op)
   * and bumps `dispatch_generation`, which every dispatch intent/offer for this
   * closure carries. Caller holds the pool row lock. Null ⇒ not open.
   */
  async closeOpen(
    tx: DbExecutor,
    poolId: string,
    reason: 'closed_full' | 'closed_timeout',
  ): Promise<{ generation: number } | null> {
    const res = await tx.execute<{ dispatch_generation: number | string }>(sql`
      UPDATE shared_rides
         SET pool_state          = ${reason},
             pool_closed_at      = now(),
             dispatch_generation = dispatch_generation + 1,
             updated_at          = now()
       WHERE ride_id = ${poolId}
         AND pool_state = 'open'
      RETURNING dispatch_generation
    `);
    const r = res.rows[0];
    return r ? { generation: Number(r.dispatch_generation) } : null;
  }

  /**
   * An open pool with no members has nothing to dispatch (legacy rows whose
   * jsonb members could not be migrated): retire it instead of closing it.
   */
  async abortEmptyOpen(tx: DbExecutor, poolId: string): Promise<boolean> {
    const res = await tx.execute(sql`
      UPDATE shared_rides
         SET pool_state = 'aborted', pool_closed_at = now(), updated_at = now()
       WHERE ride_id = ${poolId}
         AND pool_state = 'open'
         AND seat_count = 0
    `);
    return (res.rowCount ?? 0) > 0;
  }

  async setClaimed(rideId: string, driverId: string, claimedAt: Date): Promise<void> {
    await this.db
      .update(sharedRide)
      .set({
        claimedByDriverId: driverId,
        claimedAt,
        updatedAt: new Date(),
      })
      .where(eq(sharedRide.rideId, rideId));
  }
}
