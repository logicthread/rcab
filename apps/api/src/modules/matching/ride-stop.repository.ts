import { Injectable, Inject } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { rideStop, sharedRide } from '../../db/schema';

export interface RideStopRow {
  rideId: string;
  sequenceIndex: number;
  passengerId: string;
  type: 'pickup' | 'dropoff';
  lat: number;
  lng: number;
  confirmedAt: Date | null;
}

export interface RideStopInsert {
  sequenceIndex: number;
  passengerId: string;
  type: 'pickup' | 'dropoff';
  lat: number;
  lng: number;
}

function fromDb(r: {
  ride_id: string;
  sequence_index: number | string;
  passenger_id: string;
  type: string;
  lat: number | string;
  lng: number | string;
  confirmed_at: Date | null;
}): RideStopRow {
  return {
    rideId: r.ride_id,
    sequenceIndex: Number(r.sequence_index),
    passengerId: r.passenger_id,
    type: r.type as 'pickup' | 'dropoff',
    lat: Number(r.lat),
    lng: Number(r.lng),
    confirmedAt: r.confirmed_at,
  };
}

@Injectable()
export class RideStopRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async seed(rideId: string, stops: RideStopInsert[]): Promise<void> {
    if (stops.length === 0) return;
    await this.db
      .insert(rideStop)
      .values(
        stops.map((s) => ({
          rideId,
          sequenceIndex: s.sequenceIndex,
          passengerId: s.passengerId,
          type: s.type,
          lat: s.lat,
          lng: s.lng,
        })),
      )
      .onConflictDoNothing();
  }

  async findByRideId(rideId: string): Promise<RideStopRow[]> {
    const result = await this.db
      .select()
      .from(rideStop)
      .where(eq(rideStop.rideId, rideId))
      .orderBy(asc(rideStop.sequenceIndex));
    return result.map((r) => ({
      rideId: r.rideId,
      sequenceIndex: r.sequenceIndex,
      passengerId: r.passengerId,
      type: r.type as 'pickup' | 'dropoff',
      lat: r.lat,
      lng: r.lng,
      confirmedAt: r.confirmedAt,
    }));
  }

  async confirm(
    rideId: string,
    sequenceIndex: number,
    confirmedAt: Date,
  ): Promise<RideStopRow | null> {
    const result = await this.db.execute<{
      ride_id: string;
      sequence_index: number | string;
      passenger_id: string;
      type: string;
      lat: number | string;
      lng: number | string;
      confirmed_at: Date | null;
    }>(sql`
      UPDATE ride_stops
      SET    confirmed_at = ${confirmedAt}
      WHERE  ride_id = ${rideId}
        AND  sequence_index = ${sequenceIndex}
        AND  confirmed_at IS NULL
      RETURNING ride_id, sequence_index, passenger_id, type, lat, lng, confirmed_at
    `);
    const row = result.rows[0];
    return row ? fromDb(row) : null;
  }

  async countPending(rideId: string): Promise<number> {
    const result = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(rideStop)
      .where(and(eq(rideStop.rideId, rideId), isNull(rideStop.confirmedAt)));
    return Number(result[0]?.n ?? 0);
  }

  async markRideCompleted(rideId: string, completedAt: Date): Promise<void> {
    await this.db
      .update(sharedRide)
      .set({
        poolState: 'completed',
        completedAt,
        updatedAt: new Date(),
      })
      .where(eq(sharedRide.rideId, rideId));
  }

  async markRideStarted(rideId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE shared_rides
      SET    pool_state = 'closed_started',
             updated_at = now()
      WHERE  ride_id   = ${rideId}
        AND  pool_state IN ('closed_full','closed_timeout')
    `);
  }
}
