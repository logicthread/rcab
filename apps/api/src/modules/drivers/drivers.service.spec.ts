import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { RealtimeBus } from '../realtime/realtime.bus';

const DRIVER_ID = 'driver-uuid-1';
const OTHER_DRIVER_ID = 'driver-uuid-2';
const VEHICLE_ID = 'vehicle-uuid-1';

// ── Drizzle mock ─────────────────────────────────────────────────────────────

function buildDb(overrides: { selectRows?: unknown[] } = {}) {
  const returning = vi.fn();
  const limit = vi.fn();
  const whereSelect = vi.fn(() => ({ limit }));
  const whereUpdate = vi.fn(() => ({ returning }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const set = vi.fn(() => ({ where: whereUpdate }));
  const db = {
    select: vi.fn(() => ({ from })),
    update: vi.fn(() => ({ set })),
    _limit: limit,
    _returning: returning,
    _whereSelect: whereSelect,
    _whereUpdate: whereUpdate,
  };
  limit.mockResolvedValue(overrides.selectRows ?? []);
  returning.mockResolvedValue([]);
  return db;
}

// ── Redis mock ───────────────────────────────────────────────────────────────

function buildRedis() {
  return {
    geoadd: vi.fn().mockResolvedValue(1),
    hset: vi.fn().mockResolvedValue(1),
    zrem: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    hget: vi.fn().mockResolvedValue(null),
  };
}

// ── RealtimeBus mock ─────────────────────────────────────────────────────────

function buildBus() {
  return { toDriver: vi.fn() } as unknown as RealtimeBus;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeService(db: ReturnType<typeof buildDb>, redis: ReturnType<typeof buildRedis>, bus: RealtimeBus) {
  return new DriversService(db as never, redis as never, bus);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('DriversService', () => {
  let db: ReturnType<typeof buildDb>;
  let redis: ReturnType<typeof buildRedis>;
  let bus: RealtimeBus;
  let service: DriversService;

  beforeEach(() => {
    db = buildDb();
    redis = buildRedis();
    bus = buildBus();
    service = makeService(db, redis, bus);
  });

  // ── setCurrentVehicle (E3.S3) ──────────────────────────────────────────────

  describe('setCurrentVehicle', () => {
    it('sets current_vehicle_id when vehicle belongs to driver', async () => {
      const v = { id: VEHICLE_ID, driverId: DRIVER_ID };
      const updatedDriver = { userId: DRIVER_ID, currentVehicleId: VEHICLE_ID };
      db._limit.mockResolvedValue([v]);
      db._returning.mockResolvedValue([updatedDriver]);

      const result = await service.setCurrentVehicle(DRIVER_ID, VEHICLE_ID);
      expect(result).toEqual(updatedDriver);
      expect(db.update).toHaveBeenCalled();
    });

    it('throws 404 when vehicle does not exist', async () => {
      db._limit.mockResolvedValue([]);
      await expect(service.setCurrentVehicle(DRIVER_ID, VEHICLE_ID)).rejects.toThrow(NotFoundException);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('throws 403 when vehicle belongs to another driver', async () => {
      db._limit.mockResolvedValue([{ id: VEHICLE_ID, driverId: OTHER_DRIVER_ID }]);
      await expect(service.setCurrentVehicle(DRIVER_ID, VEHICLE_ID)).rejects.toThrow(ForbiddenException);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ── goOnline ───────────────────────────────────────────────────────────────

  describe('goOnline', () => {
    it('calls GEOADD with (lng, lat, driverId) order and returns ok + session_id', async () => {
      db._limit.mockResolvedValue([{ currentVehicleId: VEHICLE_ID }]);

      const result = await service.goOnline(DRIVER_ID, 12.34, 56.78);

      expect(result.ok).toBe(true);
      expect(typeof result.session_id).toBe('string');
      // Redis GEO expects (key, lng, lat, member) — verify lng comes before lat
      expect(redis.geoadd).toHaveBeenCalledWith('active_drivers', 56.78, 12.34, DRIVER_ID);
    });

    it('sets driver:state:<id> HASH with availability=online', async () => {
      db._limit.mockResolvedValue([{ currentVehicleId: VEHICLE_ID }]);

      await service.goOnline(DRIVER_ID, 12.34, 56.78);

      expect(redis.hset).toHaveBeenCalledWith(
        `driver:state:${DRIVER_ID}`,
        expect.objectContaining({ availability: 'online' }),
      );
    });

    it('throws 400 no_vehicle_selected when current_vehicle_id is null', async () => {
      db._limit.mockResolvedValue([{ currentVehicleId: null }]);
      await expect(service.goOnline(DRIVER_ID, 0, 0)).rejects.toThrow(BadRequestException);
      expect(redis.geoadd).not.toHaveBeenCalled();
    });

    it('throws 400 when driver row not found (no vehicle)', async () => {
      db._limit.mockResolvedValue([]);
      await expect(service.goOnline(DRIVER_ID, 0, 0)).rejects.toThrow(BadRequestException);
    });
  });

  // ── goOffline ──────────────────────────────────────────────────────────────

  describe('goOffline', () => {
    it('removes driver from active_drivers and deletes driver:state hash', async () => {
      const result = await service.goOffline(DRIVER_ID);

      expect(result).toEqual({ ok: true });
      expect(redis.zrem).toHaveBeenCalledWith('active_drivers', DRIVER_ID);
      expect(redis.del).toHaveBeenCalledWith(`driver:state:${DRIVER_ID}`);
    });

    it('updates Postgres availability to offline', async () => {
      await service.goOffline(DRIVER_ID);
      expect(db.update).toHaveBeenCalled();
    });
  });

  // ── autoOfflineSweep ───────────────────────────────────────────────────────

  describe('autoOfflineSweep', () => {
    it('evicts a stale driver and emits force_offline', async () => {
      const staleMs = Date.now() - 65_000; // 65 s ago
      redis.keys.mockResolvedValue([`driver:state:${DRIVER_ID}`]);
      redis.hget.mockResolvedValue(String(staleMs));

      await service.autoOfflineSweep();

      expect(redis.zrem).toHaveBeenCalledWith('active_drivers', DRIVER_ID);
      expect(bus.toDriver).toHaveBeenCalledWith(DRIVER_ID, 'force_offline', { reason: 'timeout' });
    });

    it('does not evict a fresh driver', async () => {
      const freshMs = Date.now() - 10_000; // 10 s ago
      redis.keys.mockResolvedValue([`driver:state:${DRIVER_ID}`]);
      redis.hget.mockResolvedValue(String(freshMs));

      await service.autoOfflineSweep();

      expect(redis.zrem).not.toHaveBeenCalled();
      expect(bus.toDriver).not.toHaveBeenCalled();
    });

    it('skips keys with no last_seen', async () => {
      redis.keys.mockResolvedValue([`driver:state:${DRIVER_ID}`]);
      redis.hget.mockResolvedValue(null);

      await service.autoOfflineSweep();

      expect(redis.zrem).not.toHaveBeenCalled();
    });

    it('is a no-op when no driver:state:* keys exist', async () => {
      redis.keys.mockResolvedValue([]);
      await service.autoOfflineSweep();
      expect(redis.hget).not.toHaveBeenCalled();
    });
  });
});
