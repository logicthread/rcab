import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import { RideStateMachine } from '../../src/modules/rides/ride-state-machine.service';
import { RidesRealtimeListener } from '../../src/modules/rides/rides-realtime.listener';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// RCAB-E4.S7 — the realtime → rides reactions against a real Postgres: the
// driver's first location packet implicitly advances `accepted → en_route`
// through the real RideStateMachine (SELECT … FOR UPDATE), and `ride:subscribe`
// is validated against the real ride row before a socket is joined.
describe.skipIf(skip)('RidesRealtimeListener — implicit en_route + subscribe (real Postgres)', () => {
  let pool: Pool;
  let repo: RidesRepository;
  let listener: RidesRealtimeListener;
  const bus = { toRide: vi.fn(), joinRide: vi.fn().mockResolvedValue(undefined) };
  const redis = { hdel: vi.fn().mockResolvedValue(1) };
  let passengerId: string;
  const driverId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    repo = new RidesRepository(drizzle(pool, { schema }) as never);
    const stateMachine = new RideStateMachine(repo, bus as never, redis as never);
    listener = new RidesRealtimeListener(stateMachine, repo, bus as never);

    passengerId = randomUUID();
    const phone = `+91${Math.floor(Math.random() * 1e10)
      .toString()
      .padStart(10, '0')}`;
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
      [passengerId, `fb-${passengerId}`, phone],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM rides WHERE passenger_id = $1', [passengerId]);
    await pool.query('DELETE FROM app_user WHERE id = $1', [passengerId]);
    await pool.end();
  });

  async function newAcceptedRide(): Promise<string> {
    const { row } = await repo.create({
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: `idem-${randomUUID()}`,
    });
    const bound = await repo.claimSolo(row.id, driverId, new Date());
    expect(bound?.status).toBe('accepted');
    return row.id;
  }

  it('first location advances accepted → en_route and stamps en_route_at', async () => {
    const id = await newAcceptedRide();
    await listener.onDriverFirstLocation({ rideId: id, driverId });

    const row = await repo.findById(id);
    expect(row?.status).toBe('en_route');
    expect(row?.enRouteAt).toBeInstanceOf(Date);
    // The state machine echoed the transition to the ride room.
    expect(bus.toRide).toHaveBeenCalledWith(
      id,
      'ride_state_changed',
      expect.objectContaining({ rideId: id, state: 'en_route' }),
    );
  });

  it('is idempotent — a second first-location packet is a harmless no-op', async () => {
    const id = await newAcceptedRide();
    await listener.onDriverFirstLocation({ rideId: id, driverId });
    const after1 = await repo.findById(id);
    const stampedAt = after1?.enRouteAt?.toISOString();

    // A redelivered / second packet: invalid_transition is swallowed, no write.
    await expect(
      listener.onDriverFirstLocation({ rideId: id, driverId }),
    ).resolves.toBeUndefined();

    const after2 = await repo.findById(id);
    expect(after2?.status).toBe('en_route');
    expect(after2?.enRouteAt?.toISOString()).toBe(stampedAt);
  });

  it('ignores a first-location packet from a driver who is not bound (no write)', async () => {
    const id = await newAcceptedRide();
    await listener.onDriverFirstLocation({ rideId: id, driverId: randomUUID() });

    const row = await repo.findById(id);
    expect(row?.status).toBe('accepted');
    expect(row?.enRouteAt).toBeNull();
  });

  it('ride:subscribe joins the passenger and rejects a stranger', async () => {
    const id = await newAcceptedRide();
    bus.joinRide.mockClear();

    await listener.onRideSubscribe({ userId: passengerId, rideId: id });
    expect(bus.joinRide).toHaveBeenCalledWith(passengerId, id);

    bus.joinRide.mockClear();
    await listener.onRideSubscribe({ userId: randomUUID(), rideId: id });
    expect(bus.joinRide).not.toHaveBeenCalled();
  });
});
