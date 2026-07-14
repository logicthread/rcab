import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';

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

async function seedDriverWithVehicle(): Promise<{ userId: string; vehicleId: string; jwt: string }> {
  const userId = randomUUID();
  const vehicleId = randomUUID();
  const firebaseUid = randomUUID();
  const phone = `+1203555${Math.floor(Math.random() * 9000) + 1000}`;
  const regNo = `KA-${Math.floor(Math.random() * 99)}-INT-${Math.floor(Math.random() * 9999)}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO app_user (id, firebase_uid, phone_e164, role, status) VALUES ($1, $2, $3, 'driver', 'active')",
      [userId, firebaseUid, phone],
    );
    await client.query(
      "INSERT INTO driver (user_id, current_vehicle_id) VALUES ($1, $2)",
      [userId, vehicleId],
    );
    await client.query(
      "INSERT INTO vehicle (id, driver_id, type, reg_no, make, model, color, seats, active) VALUES ($1, $2, 'cab_sedan', $3, 'Toyota', 'Camry', 'White', 4, true)",
      [vehicleId, userId, regNo],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const jwtService = moduleRef.get(JwtService);
  const jwt = jwtService.sign({ sub: userId, role: 'driver', auth_method: 'phone' });
  return { userId, vehicleId, jwt };
}

describe.skipIf(skip)('drivers online/offline round-trip', () => {
  it('POST /v1/drivers/online → ZSCORE non-null, Postgres availability=online', async () => {
    const { userId, jwt } = await seedDriverWithVehicle();
    const server = app.getHttpServer();

    const res = await supertest(server)
      .post('/v1/drivers/online')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ lat: 12.9716, lng: 77.5946 });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.session_id).toBe('string');

    // Redis: driver should be in active_drivers GEO set
    const score = await redis.zscore('active_drivers', userId);
    expect(score).not.toBeNull();

    // Redis: driver:state hash should exist with availability=online
    const avail = await redis.hget(`driver:state:${userId}`, 'availability');
    expect(avail).toBe('online');

    // Postgres: availability column updated
    const row = await pool.query<{ availability: string }>(
      'SELECT availability FROM driver WHERE user_id = $1', [userId],
    );
    expect(row.rows[0].availability).toBe('online');
  });

  it('POST /v1/drivers/offline → ZSCORE null, driver:state gone, Postgres availability=offline', async () => {
    const { userId, jwt } = await seedDriverWithVehicle();
    const server = app.getHttpServer();

    // Go online first
    await supertest(server)
      .post('/v1/drivers/online')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ lat: 12.9716, lng: 77.5946 });

    // Now go offline
    const res = await supertest(server)
      .post('/v1/drivers/offline')
      .set('Authorization', `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Redis: removed from active_drivers
    const score = await redis.zscore('active_drivers', userId);
    expect(score).toBeNull();

    // Redis: driver:state hash deleted
    const stateExists = await redis.exists(`driver:state:${userId}`);
    expect(stateExists).toBe(0);

    // Postgres
    const row = await pool.query<{ availability: string }>(
      'SELECT availability FROM driver WHERE user_id = $1', [userId],
    );
    expect(row.rows[0].availability).toBe('offline');
  });

  it('POST /v1/drivers/online with no selected vehicle → 400 no_vehicle_selected', async () => {
    const userId = randomUUID();
    const firebaseUid = randomUUID();
    const phone = `+1203444${Math.floor(Math.random() * 9000) + 1000}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO app_user (id, firebase_uid, phone_e164, role, status) VALUES ($1, $2, $3, 'driver', 'active')",
        [userId, firebaseUid, phone],
      );
      // No current_vehicle_id
      await client.query('INSERT INTO driver (user_id) VALUES ($1)', [userId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const jwtService = moduleRef.get(JwtService);
    const jwt = jwtService.sign({ sub: userId, role: 'driver', auth_method: 'phone' });

    const res = await supertest(app.getHttpServer())
      .post('/v1/drivers/online')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ lat: 12.9716, lng: 77.5946 });

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('no_vehicle_selected');
  });

  it('client JWT cannot call driver endpoints → 403', async () => {
    const userId = randomUUID();
    const firebaseUid = randomUUID();
    const phone = `+1203333${Math.floor(Math.random() * 9000) + 1000}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO app_user (id, firebase_uid, phone_e164, role, status) VALUES ($1, $2, $3, 'client', 'active')",
        [userId, firebaseUid, phone],
      );
      await client.query('INSERT INTO client (user_id) VALUES ($1)', [userId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const jwtService = moduleRef.get(JwtService);
    const jwt = jwtService.sign({ sub: userId, role: 'client', auth_method: 'phone' });

    const res = await supertest(app.getHttpServer())
      .post('/v1/drivers/online')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ lat: 12.9716, lng: 77.5946 });

    expect(res.status).toBe(403);
  });
});
