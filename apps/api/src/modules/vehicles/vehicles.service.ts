import { Injectable, Inject, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { vehicle } from '../../db/schema';
import type { CreateVehicleDto } from './dto/create-vehicle.dto';
import type { UpdateVehicleDto } from './dto/update-vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(@Inject(DRIZZLE_DB) private db: DrizzleDb) {}

  async create(driverId: string, dto: CreateVehicleDto) {
    const existing = await this.db
      .select({ id: vehicle.id })
      .from(vehicle)
      .where(and(eq(vehicle.driverId, driverId), eq(vehicle.regNo, dto.reg_no)))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException({
        code: 'vehicle_reg_exists',
        message: 'You already have a vehicle with that registration number',
      });
    }

    const [created] = await this.db
      .insert(vehicle)
      .values({
        id: randomUUID(),
        driverId,
        type: dto.type,
        regNo: dto.reg_no,
        make: dto.make,
        model: dto.model,
        color: dto.color,
        seats: dto.seats,
      })
      .returning();

    return created;
  }

  async findAllForDriver(driverId: string) {
    return this.db
      .select()
      .from(vehicle)
      .where(and(eq(vehicle.driverId, driverId), eq(vehicle.active, true)));
  }

  async update(id: string, driverId: string, dto: UpdateVehicleDto) {
    const [existing] = await this.db
      .select({ id: vehicle.id, driverId: vehicle.driverId })
      .from(vehicle)
      .where(eq(vehicle.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException({ code: 'vehicle_not_found', message: 'Vehicle not found' });
    }

    if (existing.driverId !== driverId) {
      throw new ForbiddenException({ code: 'forbidden', message: "Cannot update another driver's vehicle" });
    }

    const updates: Record<string, unknown> = {};
    if (dto.type !== undefined) updates['type'] = dto.type;
    if (dto.reg_no !== undefined) updates['regNo'] = dto.reg_no;
    if (dto.make !== undefined) updates['make'] = dto.make;
    if (dto.model !== undefined) updates['model'] = dto.model;
    if (dto.color !== undefined) updates['color'] = dto.color;
    if (dto.seats !== undefined) updates['seats'] = dto.seats;

    const [updated] = await this.db
      .update(vehicle)
      .set(updates)
      .where(eq(vehicle.id, id))
      .returning();

    return updated;
  }
}
