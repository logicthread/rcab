import { Injectable, Inject, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { driver, vehicle } from '../../db/schema';

@Injectable()
export class DriversService {
  constructor(@Inject(DRIZZLE_DB) private db: DrizzleDb) {}

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
}
