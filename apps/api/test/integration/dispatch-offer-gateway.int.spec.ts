// T18 / T31 (server side) through the real WebSocket handler: the gateway's
// `ride_offer_response` validation + driver-role check, the DI-wired
// `emitAsync` → DispatchService listener, and the returned Socket.IO ack —
// against the booted AppModule with real Postgres + Redis.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';
import { RealtimeGateway } from '../../src/modules/realtime/realtime.gateway';
import { RealtimeBus } from '../../src/modules/realtime/realtime.bus';
import {
  guardsFor,
  insertOffer,
  markOnline,
  offerState,
  seedClient,
  seedDriver,
  seedSoloRide,
} from './support/dispatch-fixtures';

const skip = process.env.RCAB_INT_SKIPPED === '1';

let moduleRef: TestingModule;
let app: INestApplication;
let pool: Pool;
let redis: Redis;

beforeAll(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
  redis = new Redis(process.env.TEST_REDIS_URL!);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool)
    .overrideProvider(REDIS).useValue(redis)
    .overrideProvider(FirebaseAdminService).useValue({ verifyIdToken: vi.fn() })
    .overrideProvider(GoogleVerifierService).useValue({ verifyIdToken: vi.fn() })
    .overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 30_000);

afterAll(async () => {
  // app.close() quits the injected REDIS client (RedisModule shutdown hook).
  await app?.close();
  await pool?.end();
  vi.unstubAllGlobals();
});

function socketFor(userId: string, role: 'driver' | 'client' = 'driver'): Socket {
  return {
    data: { userId, role },
    emit: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    handshake: { auth: {}, headers: {} },
  } as unknown as Socket;
}

describe.skipIf(skip)('ride_offer_response — real handler → dispatch → ack', () => {
  it('rejects malformed payloads and non-driver sockets before touching dispatch', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const driver = socketFor(randomUUID());
    const offerId = randomUUID();

    for (const bad of [
      { offerId, accept: 'false' },
      { offerId, accept: 1 },
      { offerId },
      { offerId: 'offer-1', accept: true },
      { offerId: 42, accept: true },
      null,
      'accept',
    ]) {
      expect(await gateway.handleRideOfferResponse(bad, driver)).toEqual({
        ok: false,
        reason: 'invalid_payload',
      });
    }
    expect(
      await gateway.handleRideOfferResponse({ offerId, accept: true }, socketFor(randomUUID(), 'client')),
    ).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('accept: ack carries the committed assignment; a replay acks the same; the trip comes from the offer', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const bus = moduleRef.get(RealtimeBus);
    const toDriver = vi.spyOn(bus, 'toDriver').mockImplementation(() => undefined);
    vi.spyOn(bus, 'toRide').mockImplementation(() => undefined);

    const passenger = await seedClient(pool);
    const rideId = await seedSoloRide(pool, passenger);
    const decoyRide = await seedSoloRide(pool, passenger);
    const driverId = await seedDriver(pool);
    await markOnline(redis, driverId);
    const offerId = await insertOffer(pool, { trip: { kind: 'solo', rideId }, driverId });
    const socket = socketFor(driverId);

    // A client-sent trip id is ignored: the offer row names the trip.
    const ack = await gateway.handleRideOfferResponse(
      { offerId, accept: true, sharedRideId: decoyRide },
      socket,
    );
    expect(ack).toEqual({ ok: true, trip: { kind: 'solo', rideId }, generation: 1, replay: false });
    expect(await guardsFor(pool, { driverId })).toEqual([
      { driver_id: driverId, solo_ride_id: rideId, shared_ride_id: null },
    ]);
    expect(await guardsFor(pool, { rideId: decoyRide })).toEqual([]);
    expect(await redis.hget(`driver:state:${driverId}`, 'current_ride_id')).toBe(rideId);
    expect(toDriver).toHaveBeenCalledWith(driverId, 'ride_offer_accepted', { offerId, rideId });

    // Lost ack → the driver retries: the committed result is replayed.
    expect(await gateway.handleRideOfferResponse({ offerId, accept: true }, socket)).toMatchObject({
      ok: true,
      replay: true,
    });
    // Another driver cannot use this offer id.
    expect(
      await gateway.handleRideOfferResponse({ offerId, accept: true }, socketFor(await seedDriver(pool))),
    ).toEqual({ ok: false, reason: 'offer_not_found' });
  });

  it('decline: only the owner, only while live; the ack says which', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const passenger = await seedClient(pool);
    const rideId = await seedSoloRide(pool, passenger);
    const driverId = await seedDriver(pool);
    const offerId = await insertOffer(pool, { trip: { kind: 'solo', rideId }, driverId });

    expect(
      await gateway.handleRideOfferResponse({ offerId, accept: false }, socketFor(randomUUID())),
    ).toBe('not_found');
    expect(await gateway.handleRideOfferResponse({ offerId, accept: false }, socketFor(driverId))).toBe(
      'declined',
    );
    expect(await gateway.handleRideOfferResponse({ offerId, accept: false }, socketFor(driverId))).toBe(
      'not_live',
    );
    expect(await offerState(pool, offerId)).toBe('declined');
  });
});
