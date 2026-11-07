import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DbExecutor, type DrizzleDb } from '../../infra/db/drizzle.module';
import { RealtimeBus } from './realtime.bus';
import {
  POOL_UPDATE,
  TERMINAL_RIDE_STATUSES,
  poolUpdatePayload,
  rideStatusVersion,
  type DriverAssignmentSnapshot,
  type DriverAssignmentView,
  type DriverStopView,
  type MemberItineraryStop,
  type PoolSnapshot,
  type PoolUpdatePayload,
  type RideSnapshot,
  type VehicleView,
} from './realtime.protocol';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v);
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString();

interface PoolDbRow extends Row {
  ride_id: string;
  pool_state: string;
  seat_count: number | string;
  max_seats: number | string;
  state_version: number | string;
  claimed_by_driver_id: string | null;
  completed_at: Date | string | null;
}

interface StopDbRow extends Row {
  sequence_index: number | string;
  type: 'pickup' | 'dropoff';
  passenger_id: string;
  lat: number | string;
  lng: number | string;
  confirmed_at: Date | string | null;
}

interface RideDbRow extends Row {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  status: string;
  origin_lat: number | string;
  origin_lng: number | string;
  dest_lat: number | string;
  dest_lng: number | string;
  fare_cents: number | string;
}

/**
 * Authoritative realtime snapshots read from Postgres (R09). Every client view
 * a socket can (re)acquire — a passenger's pool, a solo ride, a driver's active
 * assignment — is built here from committed rows, never from Redis or from
 * earlier socket rooms. Reads run in one REPEATABLE READ, read-only
 * transaction so the version and the fields come from the same instant.
 *
 * Authorization lives with the read: a pool snapshot exists only for a
 * passenger with a `pool_member` row; a ride snapshot only for the ride's
 * passenger or bound driver. Possession of an id is never enough.
 */
@Injectable()
export class RealtimeSnapshotService {
  private readonly log = new Logger(RealtimeSnapshotService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(RealtimeBus) private readonly bus: RealtimeBus,
  ) {}

  private read<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  // ── authorization (cheap pre-join checks) ──────────────────────────────────

  /** Any membership row (active or released) — a member may see its pool's end. */
  async isPoolMember(poolId: string, passengerId: string): Promise<boolean> {
    if (!isUuid(poolId) || !isUuid(passengerId)) return false;
    const res = await this.db.execute(sql`
      SELECT 1 FROM pool_member WHERE pool_id = ${poolId} AND passenger_id = ${passengerId} LIMIT 1
    `);
    return res.rows.length > 0;
  }

  async isRideParty(rideId: string, userId: string): Promise<boolean> {
    if (!isUuid(rideId) || !isUuid(userId)) return false;
    const res = await this.db.execute(sql`
      SELECT 1 FROM rides
       WHERE id = ${rideId} AND (passenger_id = ${userId} OR driver_id = ${userId})
       LIMIT 1
    `);
    return res.rows.length > 0;
  }

  // ── snapshots ──────────────────────────────────────────────────────────────

  /** The pool as one member sees it; null when the caller is not a member. */
  async poolSnapshot(poolId: string, passengerId: string): Promise<PoolSnapshot | null> {
    if (!isUuid(poolId) || !isUuid(passengerId)) return null;
    return this.read(async (tx) => {
      const res = await tx.execute<
        PoolDbRow & {
          active: boolean;
          quoted_fare_cents: number | string | null;
          origin_lat: number | string;
          origin_lng: number | string;
          dest_lat: number | string;
          dest_lng: number | string;
        }
      >(sql`
        SELECT s.ride_id, s.pool_state, s.seat_count, s.max_seats, s.state_version,
               s.claimed_by_driver_id, s.completed_at,
               m.active, COALESCE(m.agreed_fare_cents, m.quoted_fare_cents) AS quoted_fare_cents,
               m.origin_lat, m.origin_lng, m.dest_lat, m.dest_lng
          FROM shared_rides s
          JOIN pool_member m ON m.pool_id = s.ride_id AND m.passenger_id = ${passengerId}
         WHERE s.ride_id = ${poolId}
      `);
      const r = res.rows[0];
      if (!r) return null;
      const stops = await this.stopRows(tx, poolId);
      const itinerary: MemberItineraryStop[] = stops.map((s) => {
        const mine = s.passenger_id === passengerId;
        return {
          sequenceIndex: num(s.sequence_index),
          type: s.type,
          mine,
          confirmed: s.confirmed_at !== null,
          ...(mine ? { lat: num(s.lat), lng: num(s.lng) } : {}),
        };
      });
      const base = poolUpdatePayload(this.poolRow(r));
      return {
        ...base,
        vehicle: base.driverId ? await this.vehicleFor(tx, base.driverId) : null,
        completedAt: iso(r.completed_at),
        me: {
          active: Boolean(r.active),
          quotedFareCents: r.quoted_fare_cents === null ? null : num(r.quoted_fare_cents),
          pickup: { lat: num(r.origin_lat), lng: num(r.origin_lng) },
          dropoff: { lat: num(r.dest_lat), lng: num(r.dest_lng) },
        },
        itinerary,
      };
    });
  }

  /** A solo ride for its passenger or bound driver; null otherwise. */
  async rideSnapshot(rideId: string, userId: string): Promise<RideSnapshot | null> {
    if (!isUuid(rideId) || !isUuid(userId)) return null;
    return this.read(async (tx) => {
      const res = await tx.execute<RideDbRow>(sql`
        SELECT id, passenger_id, driver_id, status, origin_lat, origin_lng, dest_lat, dest_lng,
               fare_cents
          FROM rides
         WHERE id = ${rideId} AND (passenger_id = ${userId} OR driver_id = ${userId})
      `);
      const r = res.rows[0];
      if (!r) return null;
      return {
        rideId: r.id,
        version: rideStatusVersion(r.status),
        status: r.status,
        terminal: TERMINAL_RIDE_STATUSES.includes(r.status),
        driverId: r.driver_id,
        vehicle: r.driver_id ? await this.vehicleFor(tx, r.driver_id) : null,
        pickup: { lat: num(r.origin_lat), lng: num(r.origin_lng) },
        dropoff: { lat: num(r.dest_lat), lng: num(r.dest_lng) },
        fareCents: num(r.fare_cents),
      };
    });
  }

  /** The driver's committed assignment (`driver_active_assignment`), or none. */
  async driverAssignment(driverId: string): Promise<DriverAssignmentSnapshot> {
    if (!isUuid(driverId)) return { driverId, assignment: null };
    const assignment = await this.read(async (tx) => {
      const res = await tx.execute<{
        solo_ride_id: string | null;
        shared_ride_id: string | null;
        offer_id: string | null;
        dispatch_generation: number | string;
        assigned_at: Date | string;
      }>(sql`
        SELECT solo_ride_id, shared_ride_id, offer_id, dispatch_generation, assigned_at
          FROM driver_active_assignment
         WHERE driver_id = ${driverId}
      `);
      const a = res.rows[0];
      if (!a) return null;
      const common = {
        offerId: a.offer_id,
        generation: num(a.dispatch_generation),
        assignedAt: iso(a.assigned_at) as string,
      };
      if (a.solo_ride_id) {
        const rides = await tx.execute<RideDbRow>(sql`
          SELECT id, passenger_id, driver_id, status, origin_lat, origin_lng, dest_lat, dest_lng,
                 fare_cents
            FROM rides WHERE id = ${a.solo_ride_id}
        `);
        const r = rides.rows[0];
        if (!r) return null;
        const view: DriverAssignmentView = {
          tripKind: 'solo',
          tripId: r.id,
          rideId: r.id,
          ...common,
          version: rideStatusVersion(r.status),
          status: r.status,
          pickup: { lat: num(r.origin_lat), lng: num(r.origin_lng) },
          dropoff: { lat: num(r.dest_lat), lng: num(r.dest_lng) },
          fareCents: num(r.fare_cents),
        };
        return view;
      }
      const poolId = a.shared_ride_id as string;
      const pools = await tx.execute<PoolDbRow>(sql`
        SELECT ride_id, pool_state, seat_count, max_seats, state_version, claimed_by_driver_id,
               completed_at
          FROM shared_rides WHERE ride_id = ${poolId}
      `);
      const p = pools.rows[0];
      if (!p) return null;
      const stops: DriverStopView[] = (await this.stopRows(tx, poolId)).map((s) => ({
        sequenceIndex: num(s.sequence_index),
        type: s.type,
        passengerId: s.passenger_id,
        lat: num(s.lat),
        lng: num(s.lng),
        confirmed: s.confirmed_at !== null,
        confirmedAt: iso(s.confirmed_at),
      }));
      const view: DriverAssignmentView = {
        tripKind: 'shared',
        tripId: poolId,
        sharedRideId: poolId,
        ...common,
        version: num(p.state_version),
        poolStatus: p.pool_state,
        seatCount: num(p.seat_count),
        stops,
      };
      return view;
    });
    return { driverId, assignment };
  }

  /** The member-visible pool fields (no per-member data). */
  async poolUpdate(poolId: string): Promise<PoolUpdatePayload | null> {
    if (!isUuid(poolId)) return null;
    const res = await this.db.execute<PoolDbRow>(sql`
      SELECT ride_id, pool_state, seat_count, max_seats, state_version, claimed_by_driver_id,
             completed_at
        FROM shared_rides WHERE ride_id = ${poolId}
    `);
    const r = res.rows[0];
    return r ? poolUpdatePayload(this.poolRow(r)) : null;
  }

  /**
   * Post-commit: re-read the committed pool and broadcast its versioned
   * `pool:update` to the pool room. Best effort — a miss is repaired by the
   * next snapshot a client requests; never throws.
   */
  async publishPoolUpdate(poolId: string): Promise<void> {
    try {
      const payload = await this.poolUpdate(poolId);
      if (payload) this.bus.toPool(poolId, POOL_UPDATE, payload);
    } catch (err) {
      this.log.warn({ err, poolId }, 'publishPoolUpdate failed; snapshot will repair');
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private poolRow(r: PoolDbRow) {
    return {
      rideId: r.ride_id,
      stateVersion: num(r.state_version),
      seatCount: num(r.seat_count),
      maxSeats: num(r.max_seats),
      poolState: r.pool_state,
      claimedByDriverId: r.claimed_by_driver_id,
    };
  }

  private async stopRows(tx: DbExecutor, poolId: string): Promise<StopDbRow[]> {
    const res = await tx.execute<StopDbRow>(sql`
      SELECT sequence_index, type, passenger_id, lat, lng, confirmed_at
        FROM ride_stops WHERE ride_id = ${poolId}
       ORDER BY sequence_index
    `);
    return res.rows;
  }

  private async vehicleFor(tx: DbExecutor, driverId: string): Promise<VehicleView | null> {
    const res = await tx.execute<{
      type: string;
      reg_no: string;
      make: string | null;
      model: string | null;
      color: string | null;
    }>(sql`
      SELECT type, reg_no, make, model, color FROM vehicle
       WHERE driver_id = ${driverId} AND active
       ORDER BY created_at DESC
       LIMIT 1
    `);
    const v = res.rows[0];
    return v
      ? { type: v.type, regNo: v.reg_no, make: v.make, model: v.model, color: v.color }
      : null;
  }
}
