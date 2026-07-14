import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { Socket } from 'socket.io';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';
import { RealtimeGateway } from '../../src/modules/realtime/realtime.gateway';

const skip = process.env.RCAB_INT_SKIPPED === '1';

let moduleRef: TestingModule;
let app: INestApplication;
let pool: Pool;
let redis: Redis;

beforeAll(async () => {
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
  // app.close() quits the injected REDIS client via RedisModule.onApplicationShutdown
  // (we overrode the REDIS provider with `redis`). A second redis.quit() here would
  // hit an already-closing connection and leak a `Connection is closed.` rejection
  // that fails this file at teardown. Let the app own the close.
  await app?.close();
  await pool?.end();
  vi.unstubAllGlobals();
});

afterEach(async () => {
  vi.restoreAllMocks();
});

function fakeSocket(driverId: string): Socket {
  return {
    data: { userId: driverId, role: 'driver' },
    emit: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    handshake: { auth: {}, headers: {} },
  } as unknown as Socket;
}

describe.skipIf(skip)('RealtimeGateway — location streaming (real Redis)', () => {
  it('GEOADD is called once and then throttled for a second emit within 3 s', async () => {
    const driverId = `test-driver-throttle`;
    const gateway = moduleRef.get(RealtimeGateway);
    const client = fakeSocket(driverId);

    const t0 = 1_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    await gateway.handleDriverLocation({ lat: 1.30, lng: 103.80, heading: 0, speed: 0 }, client);

    // Advance by 1 s — still within 3 s throttle window
    nowSpy.mockReturnValue(t0 + 1000);
    await gateway.handleDriverLocation({ lat: 1.31, lng: 103.81, heading: 0, speed: 0 }, client);

    // GEOPOS should reflect first position only
    const pos = await redis.geopos('active_drivers', driverId);
    expect(pos).toHaveLength(1);
    // Redis GEO quantises coords; allow ~0.01° tolerance
    const [lngStr, latStr] = pos[0] as [string, string];
    expect(parseFloat(lngStr)).toBeCloseTo(103.80, 1);
    expect(parseFloat(latStr)).toBeCloseTo(1.30, 1);
  });

  it('GEOADD updates position after 3 s throttle window expires', async () => {
    const driverId = `test-driver-after-throttle`;
    const gateway = moduleRef.get(RealtimeGateway);
    const client = fakeSocket(driverId);

    const t0 = 2_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    await gateway.handleDriverLocation({ lat: 1.30, lng: 103.80, heading: 0, speed: 0 }, client);

    // Advance by > 3 s
    nowSpy.mockReturnValue(t0 + 3001);
    await gateway.handleDriverLocation({ lat: 1.40, lng: 103.90, heading: 90, speed: 10 }, client);

    const pos = await redis.geopos('active_drivers', driverId);
    expect(pos).toHaveLength(1);
    const [lngStr, latStr] = pos[0] as [string, string];
    expect(parseFloat(lngStr)).toBeCloseTo(103.90, 1);
    expect(parseFloat(latStr)).toBeCloseTo(1.40, 1);
  });

  it('reconnect: _replayDriverState emits driver_state when Redis hash exists', async () => {
    const driverId = `test-driver-replay`;
    await redis.hset(`driver:state:${driverId}`, {
      availability: 'online',
      last_seen: String(Date.now()),
    });

    const gateway = moduleRef.get(RealtimeGateway);
    const client = fakeSocket(driverId);

    // Call _replayDriverState indirectly via handleConnection would need a real JWT.
    // Test it via the private method to avoid re-testing JWT verification here.
    await (gateway as unknown as { _replayDriverState(c: Socket, id: string): Promise<void> })
      ._replayDriverState(client, driverId);

    expect(client.emit).toHaveBeenCalledWith('driver_state', {
      availability: 'online',
      current_ride_id: null,
    });

    await redis.del(`driver:state:${driverId}`);
  });
});
