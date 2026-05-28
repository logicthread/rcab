import { Injectable, Inject, ForbiddenException, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { REDIS } from '../../infra/redis/redis.module';
import { driver, vehicle } from '../../db/schema';
import { RealtimeBus } from '../realtime/realtime.bus';

const AUTO_OFFLINE_THRESHOLD_MS = 60_000;
const GEO_KEY = 'active_drivers';

@Injectable()
export class DriversService {
  private readonly log = new Logger(DriversService.name);

  constructor(
    @Inject(DRIZZLE_DB) private db: DrizzleDb,
    @Inject(REDIS) private redis: Redis,
    private bus: RealtimeBus,
  ) {}

  // ── E3.S3: set current vehicle ────────────────────────────────────────────

  async setCurrentVehicle(driverId: string, vehicleId: string) {
    const [v] = await this.db
      .select({ id: vehicle.id, driverId: vehicle.driverId })
      .from(vehicle)
      .where(eq(vehicle.id, vehicleId))
      .limit(1);

    if (!v) {
      throw new NotFoundException({ code: 'vehicle_not_found', message: 'Vehicle not found' });
    }

    if (v.driverId !== driverId) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Vehicle belongs to another driver' });
    }

    const [updated] = await this.db
      .update(driver)
      .set({ currentVehicleId: vehicleId })
      .where(eq(driver.userId, driverId))
      .returning();

    return updated;
  }

  // ── E3.S4: go online ──────────────────────────────────────────────────────

  async goOnline(driverId: string, lat: number, lng: number): Promise<{ ok: true; session_id: string }> {
    const [row] = await this.db
      .select({ currentVehicleId: driver.currentVehicleId })
      .from(driver)
      .where(eq(driver.userId, driverId))
      .limit(1);

    if (!row?.currentVehicleId) {
      throw new BadRequestException({ code: 'no_vehicle_selected', message: 'Please select a vehicle before going online' });
    }

    const sessionId = randomUUID();
    const nowMs = Date.now();

    // Redis GEO uses (lng, lat) order
    await this.redis.geoadd(GEO_KEY, lng, lat, driverId);
    await this.redis.hset(`driver:state:${driverId}`, {
      availability: 'online',
      last_seen: String(nowMs),
      session_id: sessionId,
    });

    await this.db
      .update(driver)
      .set({ availability: 'online' })
      .where(eq(driver.userId, driverId));

    return { ok: true, session_id: sessionId };
  }

  // ── E3.S4: go offline ─────────────────────────────────────────────────────

  async goOffline(driverId: string): Promise<{ ok: true }> {
    await Promise.all([
      this.redis.zrem(GEO_KEY, driverId),
      this.redis.del(`driver:state:${driverId}`),
    ]);

    await this.db
      .update(driver)
      .set({ availability: 'offline' })
      .where(eq(driver.userId, driverId));

    return { ok: true };
  }

  // ── E3.S4: auto-offline heartbeat (every 15 s) ────────────────────────────

  @Cron('*/15 * * * * *')
  async autoOfflineSweep(): Promise<void> {
    const keys = await this.redis.keys('driver:state:*');
    if (keys.length === 0) return;

    const nowMs = Date.now();
    for (const key of keys) {
      const lastSeenStr = await this.redis.hget(key, 'last_seen');
      if (!lastSeenStr) continue;
      const age = nowMs - Number(lastSeenStr);
      if (age < AUTO_OFFLINE_THRESHOLD_MS) continue;

      // Extract driver_id from key "driver:state:<id>"
      const driverId = key.slice('driver:state:'.length);
      this.log.warn(`Auto-offline: driver ${driverId} silent for ${Math.round(age / 1000)}s`);
      await this.goOffline(driverId);
      this.bus.toDriver(driverId, 'force_offline', { reason: 'timeout' });
    }
  }
}
