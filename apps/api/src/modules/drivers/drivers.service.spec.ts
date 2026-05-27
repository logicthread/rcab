import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DriversService } from './drivers.service';

const DRIVER_ID = 'driver-uuid-1';
const OTHER_DRIVER_ID = 'driver-uuid-2';
const VEHICLE_ID = 'vehicle-uuid-1';

function buildDb() {
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
    _whereUpdate: whereUpdate,
  };
  limit.mockResolvedValue([]);
  returning.mockResolvedValue([]);
  return db;
}

describe('DriversService', () => {
  let service: DriversService;
  let db: ReturnType<typeof buildDb>;

  beforeEach(() => {
    db = buildDb();
    service = new DriversService(db as never);
  });

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
});
