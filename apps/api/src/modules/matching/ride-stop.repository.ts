import { Injectable, Inject } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DbExecutor, type DrizzleDb } from '../../infra/db/drizzle.module';
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

function fromDb(r: {
  ride_id: string;
  sequence_index: number | string;
  passenger_id: string;
  type: string;
  lat: number | string;
  lng: number | string;
  confirmed_at: Date | string | null;
}): RideStopRow {
  return {
    rideId: r.ride_id,
    sequenceIndex: Number(r.sequence_index),
    passengerId: r.passenger_id,
    type: r.type as 'pickup' | 'dropoff',
    lat: Number(r.lat),
    lng: Number(r.lng),
    // Raw `execute` rows carry timestamps as driver strings (drizzle's pg parsers).
    confirmedAt: r.confirmed_at === null ? null : new Date(r.confirmed_at),
  };
}

/**
 * A pool's persisted itinerary (`ride_stops`). Slice C writes it at pool
 * closure; this repository reads it and records stop confirmations. Every
 * method takes an optional executor so the stop-confirmation transaction (which
 * holds the pool row lock) can run them; the default is the pool-backed db.
 */
@Injectable()
export class RideStopRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findByRideId(rideId: string, db: DbExecutor = this.db): Promise<RideStopRow[]> {
    const result = await db
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

  /** Stamp one unconfirmed stop on the DB clock. `null` ⇒ already confirmed / unknown. */
  async confirm(
    rideId: string,
    sequenceIndex: number,
    db: DbExecutor = this.db,
  ): Promise<RideStopRow | null> {
    const result = await db.execute<{
      ride_id: string;
      sequence_index: number | string;
      passenger_id: string;
      type: string;
      lat: number | string;
      lng: number | string;
      confirmed_at: Date | string | null;
    }>(sql`
      UPDATE ride_stops
      SET    confirmed_at = now()
      WHERE  ride_id = ${rideId}
        AND  sequence_index = ${sequenceIndex}
        AND  confirmed_at IS NULL
      RETURNING ride_id, sequence_index, passenger_id, type, lat, lng, confirmed_at
    `);
    const row = result.rows[0];
    return row ? fromDb(row) : null;
  }

  async countPending(rideId: string, db: DbExecutor = this.db): Promise<number> {
    const result = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(rideStop)
      .where(and(eq(rideStop.rideId, rideId), isNull(rideStop.confirmedAt)));
    return Number(result[0]?.n ?? 0);
  }

  async countAll(rideId: string, db: DbExecutor = this.db): Promise<number> {
    const result = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(rideStop)
      .where(eq(rideStop.rideId, rideId));
    return Number(result[0]?.n ?? 0);
  }

  /** Final stop confirmed → `completed`. Only from a started/claimed pool. */
  async markRideCompleted(rideId: string, db: DbExecutor = this.db): Promise<Date | null> {
    const updated = await db
      .update(sharedRide)
      .set({ poolState: 'completed', completedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(sharedRide.rideId, rideId),
          inArray(sharedRide.poolState, ['closed_full', 'closed_timeout', 'closed_started']),
        ),
      )
      .returning({ completedAt: sharedRide.completedAt });
    return updated[0]?.completedAt ?? null;
  }

  async markRideStarted(rideId: string, db: DbExecutor = this.db): Promise<void> {
    await db.execute(sql`
      UPDATE shared_rides
      SET    pool_state = 'closed_started',
             updated_at = now()
      WHERE  ride_id   = ${rideId}
        AND  pool_state IN ('closed_full','closed_timeout')
    `);
  }
}
