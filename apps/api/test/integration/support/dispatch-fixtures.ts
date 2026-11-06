// Shared Postgres fixtures for the Stage C offer / assignment integration
// specs. Everything is seeded with raw SQL so the specs exercise slice A's
// code without depending on the pool-creation or booking-creation paths.
import { randomUUID } from 'node:crypto';
import type { Client, Pool, PoolClient } from 'pg';
import { vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { uniquePhone } from '@rcab/test-fixtures';
import * as schema from '../../../src/db/schema';
import type { DrizzleDb } from '../../../src/infra/db/drizzle.module';
import { SharedRideRepository } from '../../../src/modules/matching/shared-ride.repository';
import { RideStopRepository } from '../../../src/modules/matching/ride-stop.repository';
import { PoolProjectionService } from '../../../src/modules/matching/pool-projection.service';
import { RidesRepository } from '../../../src/modules/rides/rides.repository';
import { DispatchService } from '../../../src/modules/dispatch/dispatch.service';
import { DispatchOfferRepository } from '../../../src/modules/dispatch/offer.repository';
import { DriverAssignmentRepository } from '../../../src/modules/dispatch/assignment.repository';
import { DriverAssignmentProjection } from '../../../src/modules/dispatch/driver-assignment.projection';
import { computeStops } from '../../../src/modules/dispatch/dispatch.service';
import type { TripRef } from '../../../src/modules/dispatch/dispatch.types';

type Db = Pool | PoolClient | Client;

export interface Bus {
  toDriver: ReturnType<typeof vi.fn>;
  toUser: ReturnType<typeof vi.fn>;
  toRide: ReturnType<typeof vi.fn>;
  toPool: ReturnType<typeof vi.fn>;
  joinPool: ReturnType<typeof vi.fn>;
  joinRide: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
}

export function makeBus(): Bus {
  return {
    toDriver: vi.fn(),
    toUser: vi.fn(),
    toRide: vi.fn(),
    toPool: vi.fn(),
    joinPool: vi.fn().mockResolvedValue(undefined),
    joinRide: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
  };
}

export function drizzleOn(pool: Pool): DrizzleDb {
  return drizzle(pool, { schema }) as unknown as DrizzleDb;
}

export interface DispatchHarness {
  db: DrizzleDb;
  dispatch: DispatchService;
  offers: DispatchOfferRepository;
  assignments: DriverAssignmentRepository;
  projection: DriverAssignmentProjection;
  rides: RidesRepository;
  stops: RideStopRepository;
  shared: SharedRideRepository;
  poolProjection: PoolProjectionService;
}

/** A full DispatchService over its own pg Pool (independent connections). */
export function buildDispatch(pgPool: Pool, redis: Redis, queue: Queue, bus: Bus): DispatchHarness {
  const db = drizzleOn(pgPool);
  const shared = new SharedRideRepository(db);
  const rides = new RidesRepository(db);
  const stops = new RideStopRepository(db);
  const offers = new DispatchOfferRepository();
  const assignments = new DriverAssignmentRepository();
  const projection = new DriverAssignmentProjection(db, redis, assignments, offers);
  const config = { get: vi.fn().mockReturnValue(undefined) };
  const poolProjection = new PoolProjectionService(shared, redis);
  const dispatch = new DispatchService(
    shared,
    rides,
    stops,
    offers,
    assignments,
    projection,
    bus as never,
    queue,
    redis,
    db,
    config as never,
    poolProjection,
  );
  return { db, dispatch, offers, assignments, projection, rides, stops, shared, poolProjection };
}

export async function seedClient(db: Db): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
    [id, `fb-a-${id}`, uniquePhone()],
  );
  return id;
}

/** An active driver account + driver row + (by default) an active 4-seat vehicle. */
export async function seedDriver(
  db: Db,
  opts: { seats?: number; vehicle?: boolean; status?: 'active' | 'suspended' } = {},
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO app_user (id, firebase_uid, phone_e164, role, status)
     VALUES ($1, $2, $3, 'driver', $4)`,
    [id, `fb-a-${id}`, uniquePhone(), opts.status ?? 'active'],
  );
  await db.query(`INSERT INTO driver (user_id) VALUES ($1)`, [id]);
  if (opts.vehicle !== false) {
    await db.query(
      `INSERT INTO vehicle (id, driver_id, type, reg_no, seats, active)
       VALUES ($1, $2, 'cab_sedan', $3, $4, true)`,
      [randomUUID(), id, `REG-${id.slice(0, 13)}`, opts.seats ?? 4],
    );
  }
  return id;
}

/** A `requested` solo ride already on dispatch generation `generation`. */
export async function seedSoloRide(
  db: Db,
  passengerId: string,
  opts: { generation?: number; lat?: number; lng?: number } = {},
): Promise<string> {
  const lat = opts.lat ?? 26.1445;
  const lng = opts.lng ?? 91.7362;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO rides (passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, fare_cents,
                        status, type, idempotency_key, idempotency_operation, dispatch_generation)
     VALUES ($1, $2, $3, $4, $5, 18500, 'requested', 'normal', $6, 'ride.create.solo', $7)
     RETURNING id`,
    [passengerId, lat, lng, lat + 0.03, lng + 0.05, `idem-${randomUUID()}`, opts.generation ?? 1],
  );
  return rows[0].id;
}

/**
 * A dispatched pool: opened, `members` passengers joined through `pool_member`
 * (the 0016 trigger derives seat_count), then closed on `generation` with its
 * itinerary persisted — what slice C's closure commits. `withStops: false`
 * leaves `ride_stops` empty (T22).
 */
export async function seedClosedPool(
  db: Db,
  opts: {
    members?: number;
    maxSeats?: number;
    generation?: number;
    state?: 'closed_full' | 'closed_timeout';
    withStops?: boolean;
    lat?: number;
    lng?: number;
  } = {},
): Promise<{ poolId: string; passengers: string[] }> {
  const poolId = randomUUID();
  const n = opts.members ?? 2;
  const lat = opts.lat ?? 22.5727;
  const lng = opts.lng ?? 88.364;
  await db.query(
    `INSERT INTO shared_rides (ride_id, max_seats, pool_state, origin_lat, origin_lng,
                               dest_lat, dest_lng, members)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, '[]'::jsonb)`,
    [poolId, opts.maxSeats ?? Math.max(n, 2), lat, lng, lat + 0.0074, lng + 0.0061],
  );
  const passengers: string[] = [];
  const members: schema.SharedRideMember[] = [];
  for (let i = 0; i < n; i++) {
    const p = await seedClient(db);
    passengers.push(p);
    const m = {
      passenger_id: p,
      origin_lat: lat + i * 0.0003,
      origin_lng: lng + i * 0.0005,
      dest_lat: lat + 0.0074 + i * 0.0004,
      dest_lng: lng + 0.0061 + i * 0.0004,
      joined_at: new Date().toISOString(),
    };
    members.push(m);
    await db.query(
      `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [poolId, p, m.origin_lat, m.origin_lng, m.dest_lat, m.dest_lng],
    );
  }
  await db.query(
    `UPDATE shared_rides SET pool_state = $2, pool_closed_at = now(), dispatch_generation = $3
      WHERE ride_id = $1`,
    [poolId, opts.state ?? 'closed_full', opts.generation ?? 1],
  );
  if (opts.withStops !== false) {
    const stops = computeStops({
      originLat: lat,
      originLng: lng,
      members,
    } as never);
    for (const s of stops) {
      await db.query(
        `INSERT INTO ride_stops (ride_id, sequence_index, passenger_id, type, lat, lng)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [poolId, s.sequenceIndex, s.passengerId, s.type, s.lat, s.lng],
      );
    }
  }
  return { poolId, passengers };
}

/** A live offer inserted directly (bypasses candidate eligibility — race simulation). */
export async function insertOffer(
  db: Db,
  p: { trip: TripRef; driverId: string; generation?: number; ttlMs?: number },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO dispatch_offer (trip_kind, ride_id, shared_ride_id, driver_id,
                                 dispatch_generation, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6::int * interval '1 millisecond')
     RETURNING id`,
    [
      p.trip.kind,
      p.trip.kind === 'solo' ? p.trip.rideId : null,
      p.trip.kind === 'shared' ? p.trip.sharedRideId : null,
      p.driverId,
      p.generation ?? 1,
      p.ttlMs ?? 12_000,
    ],
  );
  return rows[0].id;
}

/** Move an offer's whole window into the past (it lapsed but nobody swept it). */
export async function backdateOffer(db: Db, offerId: string): Promise<void> {
  await db.query(
    `UPDATE dispatch_offer SET offered_at = now() - interval '1 minute',
                               expires_at = now() - interval '30 seconds'
      WHERE id = $1`,
    [offerId],
  );
}

/** Present driver hash, as the presence path would have created it. */
export async function markOnline(redis: Redis, driverId: string): Promise<void> {
  await redis.hset(`driver:state:${driverId}`, {
    availability: 'online',
    last_seen: String(Date.now()),
  });
}

export async function offerState(db: Db, offerId: string): Promise<string> {
  const { rows } = await db.query<{ state: string }>(
    'SELECT state FROM dispatch_offer WHERE id = $1',
    [offerId],
  );
  return rows[0]?.state;
}

export async function guardsFor(
  db: Db,
  where: { driverId?: string; rideId?: string; poolId?: string },
): Promise<Array<{ driver_id: string; solo_ride_id: string | null; shared_ride_id: string | null }>> {
  const { rows } = await db.query(
    `SELECT driver_id, solo_ride_id, shared_ride_id FROM driver_active_assignment
      WHERE ($1::uuid IS NULL OR driver_id = $1)
        AND ($2::uuid IS NULL OR solo_ride_id = $2)
        AND ($3::uuid IS NULL OR shared_ride_id = $3)`,
    [where.driverId ?? null, where.rideId ?? null, where.poolId ?? null],
  );
  return rows;
}

/**
 * Contract §6 invariants I1–I4 (slice A owns them), scoped to the trips a spec
 * created (the integration DB is shared with other suites that seed
 * deliberately-invalid rows to test constraints). Each must return no rows.
 */
export async function assignmentInvariantViolations(
  db: Db,
  scope: { rideIds?: string[]; poolIds?: string[] },
): Promise<Record<string, unknown[]>> {
  const rideIds = scope.rideIds ?? [];
  const poolIds = scope.poolIds ?? [];
  const I1 = await db.query(
    `SELECT r.id FROM rides r
      WHERE r.id = ANY($1::uuid[])
        AND r.status IN ('accepted','en_route','arrived','in_progress')
        AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a
                         WHERE a.solo_ride_id = r.id AND a.driver_id = r.driver_id)
     UNION ALL
     SELECT a.solo_ride_id FROM driver_active_assignment a JOIN rides r ON r.id = a.solo_ride_id
      WHERE a.solo_ride_id = ANY($1::uuid[])
        AND (r.status NOT IN ('accepted','en_route','arrived','in_progress')
             OR r.driver_id <> a.driver_id)`,
    [rideIds],
  );
  const I2 = await db.query(
    `SELECT s.ride_id FROM shared_rides s
      WHERE s.ride_id = ANY($1::uuid[])
        AND s.claimed_by_driver_id IS NOT NULL
        AND s.pool_state IN ('closed_full','closed_timeout','closed_started')
        AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a
                         WHERE a.shared_ride_id = s.ride_id
                           AND a.driver_id = s.claimed_by_driver_id)
     UNION ALL
     SELECT a.shared_ride_id FROM driver_active_assignment a
       JOIN shared_rides s ON s.ride_id = a.shared_ride_id
      WHERE a.shared_ride_id = ANY($1::uuid[])
        AND (s.pool_state IN ('open','aborted','completed')
             OR s.claimed_by_driver_id IS DISTINCT FROM a.driver_id)`,
    [poolIds],
  );
  const I3 = await db.query(
    `SELECT o.id FROM dispatch_offer o
      WHERE o.ride_id = ANY($1::uuid[])
        AND o.state = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.offer_id = o.id)
        AND EXISTS (SELECT 1 FROM rides r WHERE r.id = o.ride_id
                      AND r.status IN ('accepted','en_route','arrived','in_progress'))`,
    [rideIds],
  );
  const I4 = await db.query(
    `SELECT o.id FROM dispatch_offer o LEFT JOIN rides r ON r.id = o.ride_id
       LEFT JOIN shared_rides s ON s.ride_id = o.shared_ride_id
      WHERE (o.ride_id = ANY($1::uuid[]) OR o.shared_ride_id = ANY($2::uuid[]))
        AND o.state = 'offered'
        AND ((r.id IS NOT NULL AND (r.status <> 'requested'
                                    OR r.dispatch_generation <> o.dispatch_generation))
          OR (s.ride_id IS NOT NULL AND (s.claimed_by_driver_id IS NOT NULL
                                         OR s.pool_state NOT IN ('closed_full','closed_timeout')
                                         OR s.dispatch_generation <> o.dispatch_generation)))`,
    [rideIds, poolIds],
  );
  const out: Record<string, unknown[]> = {};
  for (const [k, r] of Object.entries({ I1, I2, I3, I4 })) {
    if (r.rows.length > 0) out[k] = r.rows;
  }
  return out;
}

/** A promise you resolve from outside: a barrier between concurrent actors. */
export function barrier(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}
