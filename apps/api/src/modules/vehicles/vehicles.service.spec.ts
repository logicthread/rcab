import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehicleType } from './dto/create-vehicle.dto';

function makeDto() {
  return {
    type: VehicleType.CabSedan,
    reg_no: 'KA-01-AB-1234',
    make: 'Toyota',
    model: 'Camry',
    color: 'White',
    seats: 4,
  };
}

const DRIVER_ID = 'driver-uuid-1';
const OTHER_DRIVER_ID = 'driver-uuid-2';
const VEHICLE_ID = 'vehicle-uuid-1';

function buildDb() {
  const returning = vi.fn();
  const limit = vi.fn();
  const whereInsertOrSelect = vi.fn();
  const whereUpdate = vi.fn(() => ({ returning }));
  const from = vi.fn(() => ({ where: whereInsertOrSelect }));
  const set = vi.fn(() => ({ where: whereUpdate }));
  const values = vi.fn(() => ({ returning }));
  const db = {
    select: vi.fn(() => ({ from })),
    insert: vi.fn(() => ({ values })),
    update: vi.fn(() => ({ set })),
    _returning: returning,
    _limit: limit,
    _whereSelect: whereInsertOrSelect,
  };
  // by default, terminal methods resolve empty
  whereInsertOrSelect.mockReturnValue({ limit, returning });
  limit.mockResolvedValue([]);
  returning.mockResolvedValue([]);
  return db;
}

describe('VehiclesService', () => {
  let service: VehiclesService;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    db = buildDb();
    service = new VehiclesService(db as never);
  });

  describe('create', () => {
    it('creates a vehicle when reg_no is not a duplicate for this driver', async () => {
      const created = { id: VEHICLE_ID, driverId: DRIVER_ID, regNo: 'KA-01-AB-1234' };
      db._limit.mockResolvedValue([]); // no duplicate found
      db._returning.mockResolvedValue([created]);

      const result = await service.create(DRIVER_ID, makeDto());

      expect(result).toEqual(created);
      expect(db.insert).toHaveBeenCalled();
    });

    it('throws 409 vehicle_reg_exists when driver already has that reg_no', async () => {
      db._limit.mockResolvedValue([{ id: VEHICLE_ID }]); // duplicate found

      await expect(service.create(DRIVER_ID, makeDto())).rejects.toThrow(ConflictException);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('findAllForDriver', () => {
    it('returns active vehicles for the driver', async () => {
      const vehicles = [{ id: VEHICLE_ID, driverId: DRIVER_ID, active: true }];
      db._whereSelect.mockResolvedValue(vehicles);

      const result = await service.findAllForDriver(DRIVER_ID);
      expect(result).toEqual(vehicles);
    });
  });

  describe('update', () => {
    it('updates own vehicle', async () => {
      const existing = { id: VEHICLE_ID, driverId: DRIVER_ID };
      const updated = { id: VEHICLE_ID, driverId: DRIVER_ID, color: 'Black' };
      db._limit.mockResolvedValue([existing]);
      db._returning.mockResolvedValue([updated]);

      const result = await service.update(VEHICLE_ID, DRIVER_ID, { color: 'Black' });
      expect(result).toEqual(updated);
      expect(db.update).toHaveBeenCalled();
    });

    it('throws 404 when vehicle does not exist', async () => {
      db._limit.mockResolvedValue([]);

      await expect(service.update(VEHICLE_ID, DRIVER_ID, { color: 'Red' })).rejects.toThrow(NotFoundException);
    });

    it('throws 403 when updating another driver\'s vehicle', async () => {
      db._limit.mockResolvedValue([{ id: VEHICLE_ID, driverId: OTHER_DRIVER_ID }]);

      await expect(service.update(VEHICLE_ID, DRIVER_ID, { color: 'Red' })).rejects.toThrow(ForbiddenException);
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
