import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';

const skip = process.env.RCAB_INT_SKIPPED === '1';

async function seedDriver(pool: Pool): Promise<{ userId: string; jwt: string; moduleRef: TestingModule }> {
  throw new Error('call seedDriver after moduleRef is set');
}

let moduleRef: TestingModule;
let app: INestApplication;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });

  const mockRedis = { ping: vi.fn().mockResolvedValue('PONG'), quit: vi.fn().mockResolvedValue('OK') };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool)
    .overrideProvider(REDIS).useValue(mockRedis)
    .overrideProvider(FirebaseAdminService).useValue({ verifyIdToken: vi.fn() })
    .overrideProvider(GoogleVerifierService).useValue({ verifyIdToken: vi.fn() })
    .overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  vi.unstubAllGlobals();
});

async function createDriverAndJwt(): Promise<{ userId: string; jwt: string }> {
  const userId = randomUUID();
  const firebaseUid = randomUUID();
  const phone = `+1202555${Math.floor(Math.random() * 9000) + 1000}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO app_user (id, firebase_uid, phone_e164, role, status) VALUES ($1, $2, $3, 'driver', 'active')",
      [userId, firebaseUid, phone],
    );
    await client.query('INSERT INTO driver (user_id) VALUES ($1)', [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const jwtService = moduleRef.get(JwtService);
  const jwt = jwtService.sign({ sub: userId, role: 'driver', auth_method: 'phone' });
  return { userId, jwt };
}

describe.skipIf(skip)('vehicles round-trip', () => {
  it('POST /v1/vehicles → GET /v1/vehicles → PATCH /v1/drivers/me/vehicle sets current_vehicle_id', async () => {
    const { userId, jwt } = await createDriverAndJwt();
    const server = app.getHttpServer();

    // Create a vehicle
    const createRes = await supertest(server)
      .post('/v1/vehicles')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ type: 'cab_sedan', reg_no: `KA-01-AB-${userId.slice(0, 4)}`, make: 'Toyota', model: 'Camry', color: 'White', seats: 4 });

    expect(createRes.status).toBe(201);
    expect(createRes.body.id).toBeTruthy();
    expect(createRes.body.driver_id ?? createRes.body.driverId).toBe(userId);
    const vehicleId = createRes.body.id;

    // List vehicles — should contain the created one
    const listRes = await supertest(server)
      .get('/v1/vehicles')
      .set('Authorization', `Bearer ${jwt}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.some((v: { id: string }) => v.id === vehicleId)).toBe(true);

    // Set active vehicle
    const patchRes = await supertest(server)
      .patch('/v1/drivers/me/vehicle')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ vehicle_id: vehicleId });

    expect(patchRes.status).toBe(200);

    // Verify current_vehicle_id set on driver row
    const row = await pool.query<{ current_vehicle_id: string }>(
      'SELECT current_vehicle_id FROM driver WHERE user_id = $1',
      [userId],
    );
    expect(row.rows[0].current_vehicle_id).toBe(vehicleId);
  });

  it('POST /v1/vehicles with duplicate reg_no for same driver → 409 vehicle_reg_exists', async () => {
    const { jwt } = await createDriverAndJwt();
    const regNo = `KA-02-CD-${Math.floor(Math.random() * 9000) + 1000}`;
    const server = app.getHttpServer();
    const body = { type: 'auto', reg_no: regNo, make: 'Honda', model: 'Activa', color: 'Red', seats: 2 };

    const first = await supertest(server).post('/v1/vehicles').set('Authorization', `Bearer ${jwt}`).send(body);
    expect(first.status).toBe(201);

    const second = await supertest(server).post('/v1/vehicles').set('Authorization', `Bearer ${jwt}`).send(body);
    expect(second.status).toBe(409);
    expect(second.body.error?.code ?? second.body.code).toBe('vehicle_reg_exists');
  });

  it('PATCH /v1/drivers/me/vehicle with another driver\'s vehicle → 403', async () => {
    const driverA = await createDriverAndJwt();
    const driverB = await createDriverAndJwt();
    const server = app.getHttpServer();

    // Driver A registers a vehicle
    const createRes = await supertest(server)
      .post('/v1/vehicles')
      .set('Authorization', `Bearer ${driverA.jwt}`)
      .send({ type: 'bike', reg_no: `KA-03-EF-${Math.floor(Math.random() * 9000) + 1000}`, make: 'Hero', model: 'Splendor', color: 'Blue', seats: 1 });
    const vehicleId = createRes.body.id;

    // Driver B tries to claim it
    const patchRes = await supertest(server)
      .patch('/v1/drivers/me/vehicle')
      .set('Authorization', `Bearer ${driverB.jwt}`)
      .send({ vehicle_id: vehicleId });

    expect(patchRes.status).toBe(403);
  });

  it('client JWT cannot access vehicle endpoints → 403', async () => {
    const userId = randomUUID();
    const firebaseUid = randomUUID();
    const phone = `+1202444${Math.floor(Math.random() * 9000) + 1000}`;
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
    const clientJwt = jwtService.sign({ sub: userId, role: 'client', auth_method: 'phone' });

    const res = await supertest(app.getHttpServer())
      .get('/v1/vehicles')
      .set('Authorization', `Bearer ${clientJwt}`);

    expect(res.status).toBe(403);
  });
});
