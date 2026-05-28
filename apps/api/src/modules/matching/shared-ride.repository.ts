import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { sharedRide, type SharedRideMember } from '../../db/schema';

export type { SharedRideMember } from '../../db/schema';

export interface SharedRideRow {
  rideId: string;
  seatCount: number;
  maxSeats: number;
  poolState: string;
  poolClosedAt: Date | null;
  detourBudgetM: number;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  members: SharedRideMember[];
  claimedByDriverId: string | null;
  claimedAt: Date | null;
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
  members: SharedRideMember[] | string | null;
  claimed_by_driver_id: string | null;
  claimed_at: Date | null;
}

function parseMembers(raw: SharedRideMember[] | string | null): SharedRideMember[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SharedRideMember[]) : [];
  } catch {
    return [];
  }
}

function rowFromDb(r: CandidateDbRow): SharedRideRow {
  return {
    rideId: r.ride_id,
    seatCount: Number(r.seat_count),
    maxSeats: Number(r.max_seats),
    poolState: r.pool_state,
    poolClosedAt: r.pool_closed_at ?? null,
    detourBudgetM: Number(r.detour_budget_m),
    originLat: Number(r.origin_lat),
    originLng: Number(r.origin_lng),
    destLat: Number(r.dest_lat),
    destLng: Number(r.dest_lng),
    members: parseMembers(r.members),
    claimedByDriverId: r.claimed_by_driver_id ?? null,
    claimedAt: r.claimed_at ?? null,
  };
}

@Injectable()
export class SharedRideRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findCandidates(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
  ): Promise<SharedRideRow[]> {
    const result = await this.db.execute<CandidateDbRow>(sql`
      SELECT ride_id, seat_count, max_seats, pool_state, pool_closed_at,
             detour_budget_m, origin_lat, origin_lng, dest_lat, dest_lng,
             members, claimed_by_driver_id, claimed_at
      FROM   shared_rides
      WHERE  ST_DWithin(
               origin_centroid,
               ST_SetSRID(ST_MakePoint(${originLng}, ${originLat}), 4326)::geography,
               1500
             )
        AND  ST_DWithin(
               dest_centroid,
               ST_SetSRID(ST_MakePoint(${destLng}, ${destLat}), 4326)::geography,
               1500
             )
        AND  pool_state = 'open'
        AND  seat_count < max_seats
    `);

    return result.rows.map(rowFromDb);
  }

  async findById(rideId: string): Promise<SharedRideRow | null> {
    const result = await this.db.execute<CandidateDbRow>(sql`
      SELECT ride_id, seat_count, max_seats, pool_state, pool_closed_at,
             detour_budget_m, origin_lat, origin_lng, dest_lat, dest_lng,
             members, claimed_by_driver_id, claimed_at
      FROM   shared_rides
      WHERE  ride_id = ${rideId}
      LIMIT  1
    `);
    const row = result.rows[0];
    return row ? rowFromDb(row) : null;
  }

  async create(params: {
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    maxSeats: number;
    detourBudgetM: number;
    opener: SharedRideMember;
  }): Promise<SharedRideRow> {
    const rideId = randomUUID();
    const poolClosedAt = new Date(Date.now() + 60_000);
    const members: SharedRideMember[] = [params.opener];

    await this.db.insert(sharedRide).values({
      rideId,
      seatCount: 1,
      maxSeats: params.maxSeats,
      poolState: 'open',
      poolClosedAt,
      detourBudgetM: params.detourBudgetM,
      originLat: params.originLat,
      originLng: params.originLng,
      destLat: params.destLat,
      destLng: params.destLng,
      members,
    });

    return {
      rideId,
      seatCount: 1,
      maxSeats: params.maxSeats,
      poolState: 'open',
      poolClosedAt,
      detourBudgetM: params.detourBudgetM,
      originLat: params.originLat,
      originLng: params.originLng,
      destLat: params.destLat,
      destLng: params.destLng,
      members,
      claimedByDriverId: null,
      claimedAt: null,
    };
  }

  async incrementSeats(rideId: string, newCount: number): Promise<void> {
    await this.db
      .update(sharedRide)
      .set({ seatCount: newCount, updatedAt: new Date() })
      .where(eq(sharedRide.rideId, rideId));
  }

  async appendMember(rideId: string, member: SharedRideMember): Promise<void> {
    await this.db.execute(sql`
      UPDATE shared_rides
      SET    members    = members || ${JSON.stringify([member])}::jsonb,
             updated_at = now()
      WHERE  ride_id = ${rideId}
    `);
  }

  async closePool(
    rideId: string,
    reason: 'closed_full' | 'closed_timeout' | 'closed_started' | 'aborted',
  ): Promise<void> {
    await this.db
      .update(sharedRide)
      .set({ poolState: reason, poolClosedAt: new Date(), updatedAt: new Date() })
      .where(eq(sharedRide.rideId, rideId));
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
