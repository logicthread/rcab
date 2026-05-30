import { Injectable, Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { rides } from '../../db/schema';

export interface RideRow {
  id: string;
  passengerId: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  fareCents: number;
  status: string;
  idempotencyKey: string;
  driverId: string | null;
  acceptedAt: Date | null;
}

function toRow(r: typeof rides.$inferSelect): RideRow {
  return {
    id: r.id,
    passengerId: r.passengerId,
    originLat: Number(r.originLat),
    originLng: Number(r.originLng),
    destLat: Number(r.destLat),
    destLng: Number(r.destLng),
    fareCents: Number(r.fareCents),
    status: r.status,
    idempotencyKey: r.idempotencyKey,
    driverId: r.driverId,
    acceptedAt: r.acceptedAt,
  };
}

@Injectable()
export class RidesRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Insert a solo ride in `requested` state. The `idempotency_key` UNIQUE
   * constraint is the durable dedup backstop: on conflict we return the existing
   * row instead of inserting a duplicate. `created` is false on a replay.
   */
  async create(params: {
    passengerId: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    fareCents: number;
    idempotencyKey: string;
  }): Promise<{ row: RideRow; created: boolean }> {
    const inserted = await this.db
      .insert(rides)
      .values({
        passengerId: params.passengerId,
        originLat: params.originLat,
        originLng: params.originLng,
        destLat: params.destLat,
        destLng: params.destLng,
        fareCents: params.fareCents,
        status: 'requested',
        idempotencyKey: params.idempotencyKey,
      })
      .onConflictDoNothing({ target: rides.idempotencyKey })
      .returning();

    if (inserted.length > 0) {
      return { row: toRow(inserted[0]), created: true };
    }
    const existing = await this.findByIdempotencyKey(params.idempotencyKey);
    // The conflict guarantees a row exists; the non-null assertion is safe.
    return { row: existing!, created: false };
  }

  async findById(id: string): Promise<RideRow | null> {
    const rows = await this.db.select().from(rides).where(eq(rides.id, id)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<RideRow | null> {
    const rows = await this.db.select().from(rides).where(eq(rides.idempotencyKey, key)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * First-accept-wins solo claim. Conditional on `status='requested'`, so it is
   * atomic against a concurrent claim (only one UPDATE can match the row while
   * it is requested). Returns the bound row, or null if the ride was already
   * claimed / cancelled / gone (0 rows affected). RCAB-E4.S4.
   */
  async claimSolo(rideId: string, driverId: string, acceptedAt: Date): Promise<RideRow | null> {
    const updated = await this.db
      .update(rides)
      .set({ status: 'accepted', driverId, acceptedAt, updatedAt: new Date() })
      .where(and(eq(rides.id, rideId), eq(rides.status, 'requested')))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  }

  /**
   * Terminal transition when dispatch exhausts all waves with no acceptance.
   * Guarded by `status='requested'` so it never clobbers a ride that got
   * claimed in the same instant the hard-fail timer fired. RCAB-E4.S4.
   */
  async markNoDriver(rideId: string): Promise<RideRow | null> {
    const updated = await this.db
      .update(rides)
      .set({ status: 'no_driver', updatedAt: new Date() })
      .where(and(eq(rides.id, rideId), eq(rides.status, 'requested')))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  }
}
