import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import {
  RideStateMachine,
  RIDE_CANCELLED_EVENT,
} from '../../src/modules/rides/ride-state-machine.service';
import { RidesRealtimeListener } from '../../src/modules/rides/rides-realtime.listener';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// RCAB-E4.S7/S8 — the realtime → rides reactions and the cancellation paths
// against a real Postgres: the driver's first location packet implicitly
// advances `accepted → en_route` through the real RideStateMachine
// (SELECT … FOR UPDATE), `ride:subscribe` is validated against the real ride
// row, and `cancel()` walks real rows to `cancelled` / `no_show` with the
// guarded ownership + no-show-wait checks.
describe.skipIf(skip)('RidesRealtimeListener + cancellation (real Postgres)', () => {
  let pool: Pool;
  let repo: RidesRepository;
  let stateMachine: RideStateMachine;
  let listener: RidesRealtimeListener;
  const bus = { toRide: vi.fn(), joinRide: vi.fn().mockResolvedValue(undefined) };
  const redis = { hdel: vi.fn().mockResolvedValue(1) };
  const events = { emit: vi.fn() };
  // Default 5-min no-show wait (config returns undefined → the 300_000 default).
  const config = { get: vi.fn().mockReturnValue(undefined) };
  let passengerId: string;
  const driverId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    repo = new RidesRepository(drizzle(pool, { schema }) as never);
    stateMachine = new RideStateMachine(
      repo,
      bus as never,
      events as never,
      config as never,
      redis as never,
    );
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

  async function newRequestedRide(): Promise<string> {
    const { row } = await repo.create({
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: `idem-${randomUUID()}`,
    });
    return row.id;
  }

  async function newAcceptedRide(): Promise<string> {
    const id = await newRequestedRide();
    const bound = await repo.claimSolo(id, driverId, new Date());
    expect(bound?.status).toBe('accepted');
    return id;
  }

  async function newArrivedRide(): Promise<string> {
    const id = await newAcceptedRide();
    await stateMachine.apply(id, driverId, 'start_en_route');
    await stateMachine.apply(id, driverId, 'mark_arrived');
    const row = await repo.findById(id);
    expect(row?.status).toBe('arrived');
    return id;
  }

  // ── RCAB-E4.S7 ──────────────────────────────────────────────────────────────

  it('first location advances accepted → en_route and stamps en_route_at', async () => {
    const id = await newAcceptedRide();
    await listener.onDriverFirstLocation({ rideId: id, driverId });

    const row = await repo.findById(id);
    expect(row?.status).toBe('en_route');
    expect(row?.enRouteAt).toBeInstanceOf(Date);
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

    await expect(listener.onDriverFirstLocation({ rideId: id, driverId })).resolves.toBeUndefined();

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

  // ── RCAB-E4.S8 — cancellation & no-show ───────────────────────────────────────

  it('client cancel of a still-requested ride → cancelled, no driver, emits RIDE_CANCELLED_EVENT', async () => {
    const id = await newRequestedRide();
    events.emit.mockClear();

    const res = await stateMachine.cancel({
      rideId: id,
      actor: 'client',
      actorId: passengerId,
      isNoShow: false,
      reason: null,
    });

    expect(res.ok).toBe(true);
    const row = await repo.findById(id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('client');
    expect(row?.cancelledAt).toBeInstanceOf(Date);
    expect(events.emit).toHaveBeenCalledWith(RIDE_CANCELLED_EVENT, { rideId: id, driverId: null });
  });

  it('client cancel of an arrived ride → cancelled, clears bound driver current_ride_id', async () => {
    const id = await newArrivedRide();
    redis.hdel.mockClear();

    const res = await stateMachine.cancel({
      rideId: id,
      actor: 'client',
      actorId: passengerId,
      isNoShow: false,
      reason: null,
    });

    expect(res.ok).toBe(true);
    const row = await repo.findById(id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('client');
    expect(redis.hdel).toHaveBeenCalledWith(`driver:state:${driverId}`, 'current_ride_id');
  });

  it('driver cancel records the reason', async () => {
    const id = await newAcceptedRide();
    const res = await stateMachine.cancel({
      rideId: id,
      actor: 'driver',
      actorId: driverId,
      isNoShow: false,
      reason: 'vehicle breakdown',
    });

    expect(res.ok).toBe(true);
    const row = await repo.findById(id);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledBy).toBe('driver');
    expect(row?.cancelReason).toBe('vehicle breakdown');
  });

  it('no-show before the 5-min wait → no_show_too_early, no write', async () => {
    const id = await newArrivedRide();
    const res = await stateMachine.cancel({
      rideId: id,
      actor: 'driver',
      actorId: driverId,
      isNoShow: true,
      reason: 'no_show',
    });

    expect(res).toEqual({ ok: false, reason: 'no_show_too_early' });
    const row = await repo.findById(id);
    expect(row?.status).toBe('arrived');
  });

  it('no-show after the wait (arrived_at backdated) → no_show', async () => {
    const id = await newArrivedRide();
    // Backdate arrival 10 minutes so the 5-min wait has elapsed.
    await pool.query(`UPDATE rides SET arrived_at = now() - interval '10 minutes' WHERE id = $1`, [
      id,
    ]);

    const res = await stateMachine.cancel({
      rideId: id,
      actor: 'driver',
      actorId: driverId,
      isNoShow: true,
      reason: 'no_show',
    });

    expect(res.ok).toBe(true);
    const row = await repo.findById(id);
    expect(row?.status).toBe('no_show');
    expect(row?.cancelledBy).toBe('driver');
  });

  it('rejects a cancel from someone who is not a party to the ride (no write)', async () => {
    const id = await newRequestedRide();
    const res = await stateMachine.cancel({
      rideId: id,
      actor: 'client',
      actorId: randomUUID(),
      isNoShow: false,
      reason: null,
    });

    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    const row = await repo.findById(id);
    expect(row?.status).toBe('requested');
  });
});
