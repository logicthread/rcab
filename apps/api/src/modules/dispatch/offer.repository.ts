import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor, DrizzleTx } from '../../infra/db/drizzle.module';
import type { DispatchOfferState } from '../../db/schema';
import type { DeclineOfferResult, TripRef } from './dispatch.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id we bind into SQL from a client or from Redis is shape-checked first. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The authoritative offer (F05). `lapsed` is computed on the DB clock. */
export interface OfferRow {
  id: string;
  trip: TripRef;
  driverId: string;
  generation: number;
  waveNumber: number;
  state: DispatchOfferState;
  offeredAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  /** `expires_at <= clock_timestamp()` at read time. */
  lapsed: boolean;
}

interface OfferDbRow extends Record<string, unknown> {
  id: string;
  trip_kind: 'solo' | 'shared';
  ride_id: string | null;
  shared_ride_id: string | null;
  driver_id: string;
  dispatch_generation: number | string;
  wave_number: number | string;
  state: DispatchOfferState;
  // Raw `execute` rows carry timestamps as driver strings (drizzle's pg parsers).
  offered_at: Date | string;
  expires_at: Date | string;
  resolved_at: Date | string | null;
  lapsed: boolean;
}

const OFFER_COLUMNS = sql`id, trip_kind, ride_id, shared_ride_id, driver_id, dispatch_generation,
  wave_number, state, offered_at, expires_at, resolved_at,
  (expires_at <= clock_timestamp()) AS lapsed`;

function fromDb(r: OfferDbRow): OfferRow {
  const trip: TripRef =
    r.trip_kind === 'solo'
      ? { kind: 'solo', rideId: r.ride_id as string }
      : { kind: 'shared', sharedRideId: r.shared_ride_id as string };
  return {
    id: r.id,
    trip,
    driverId: r.driver_id,
    generation: Number(r.dispatch_generation),
    waveNumber: Number(r.wave_number),
    state: r.state,
    offeredAt: new Date(r.offered_at),
    expiresAt: new Date(r.expires_at),
    resolvedAt: r.resolved_at === null ? null : new Date(r.resolved_at),
    lapsed: Boolean(r.lapsed),
  };
}

/** `ride_id = $1` or `shared_ride_id = $1` for the trip's table. */
export function offerTripPredicate(trip: TripRef): SQL {
  return trip.kind === 'solo'
    ? sql`ride_id = ${trip.rideId}`
    : sql`shared_ride_id = ${trip.sharedRideId}`;
}

/** Postgres array literal for already-validated UUIDs (drizzle expands JS arrays to lists). */
function uuidArray(ids: string[]): string {
  return `{${ids.join(',')}}`;
}

/**
 * Authoritative dispatch offers (`dispatch_offer`, migration 0014). Stateless:
 * every method runs on the executor it is handed, so the same calls take part
 * in the accept / cancel / hard-fail transactions or run on their own.
 *
 * Lock order (stage-c contract §1.3): a caller that already holds the trip row
 * lock may lock offers; the standalone writers here either take the trip lock
 * first (`createOffer`) or touch rows with `SKIP LOCKED` (`expireLapsed`) so they
 * can never deadlock against an accept.
 */
@Injectable()
export class DispatchOfferRepository {
  /**
   * Offer one trip generation to one driver. One short transaction:
   *   1. `FOR SHARE` the trip row and require it still dispatchable at this
   *      generation — serializes against accept / cancel / hard-fail, so a
   *      committed offer is always visible to their `revokeLiveForTrip` (I4);
   *   2. expire this driver's lapsed offers (frees the one-live-offer slot);
   *   3. INSERT … ON CONFLICT DO NOTHING — the partial unique index reserves
   *      the DRIVER (F06), the (trip, generation, driver) unique skips repeats.
   * `null` ⇒ trip no longer dispatchable at this generation, the driver holds a
   * live offer, or was already offered this trip generation.
   */
  async createOffer(
    db: DbExecutor,
    p: { trip: TripRef; driverId: string; generation: number; waveNumber: number; ttlMs: number },
  ): Promise<{ offerId: string; expiresAt: Date } | null> {
    return db.transaction(async (tx) => {
      const dispatchable =
        p.trip.kind === 'solo'
          ? await tx.execute(sql`
              SELECT 1 FROM rides
               WHERE id = ${p.trip.rideId} AND status = 'requested' AND driver_id IS NULL
                 AND dispatch_generation = ${p.generation}
                 FOR SHARE`)
          : await tx.execute(sql`
              SELECT 1 FROM shared_rides
               WHERE ride_id = ${p.trip.sharedRideId}
                 AND pool_state IN ('closed_full', 'closed_timeout')
                 AND claimed_by_driver_id IS NULL
                 AND dispatch_generation = ${p.generation}
                 FOR SHARE`);
      if (dispatchable.rows.length === 0) return null;

      await tx.execute(sql`
        UPDATE dispatch_offer
           SET state = 'expired', resolved_at = clock_timestamp()
         WHERE id IN (SELECT id FROM dispatch_offer
                       WHERE driver_id = ${p.driverId} AND state = 'offered'
                         AND expires_at <= clock_timestamp()
                         FOR UPDATE SKIP LOCKED)`);

      const rideId = p.trip.kind === 'solo' ? p.trip.rideId : null;
      const sharedRideId = p.trip.kind === 'shared' ? p.trip.sharedRideId : null;
      const inserted = await tx.execute<{ id: string; expires_at: Date | string }>(sql`
        INSERT INTO dispatch_offer
               (trip_kind, ride_id, shared_ride_id, driver_id, dispatch_generation,
                wave_number, expires_at)
        VALUES (${p.trip.kind}, ${rideId}, ${sharedRideId}, ${p.driverId}, ${p.generation},
                ${p.waveNumber}, now() + ${Math.max(1, Math.round(p.ttlMs))}::int * interval '1 millisecond')
        ON CONFLICT DO NOTHING
        RETURNING id, expires_at`);
      const row = inserted.rows[0];
      return row ? { offerId: row.id, expiresAt: new Date(row.expires_at) } : null;
    });
  }

  /** Unlocked read of the caller's own offer. Another driver's offer is `null` (no leak). */
  async findForDriver(db: DbExecutor, offerId: string, driverId: string): Promise<OfferRow | null> {
    if (!isUuid(offerId) || !isUuid(driverId)) return null;
    const res = await db.execute<OfferDbRow>(sql`
      SELECT ${OFFER_COLUMNS} FROM dispatch_offer
       WHERE id = ${offerId} AND driver_id = ${driverId}`);
    return res.rows[0] ? fromDb(res.rows[0]) : null;
  }

  /** `SELECT … FOR UPDATE` — call only while holding the offer's trip row lock. */
  async lockForUpdate(tx: DrizzleTx, offerId: string): Promise<OfferRow | null> {
    if (!isUuid(offerId)) return null;
    const res = await tx.execute<OfferDbRow>(sql`
      SELECT ${OFFER_COLUMNS} FROM dispatch_offer WHERE id = ${offerId} FOR UPDATE`);
    return res.rows[0] ? fromDb(res.rows[0]) : null;
  }

  async markAccepted(tx: DrizzleTx, offerId: string): Promise<void> {
    if (!(await this.resolveLive(tx, offerId, 'accepted'))) {
      throw new Error(`dispatch_offer ${offerId} is not live; cannot accept`);
    }
  }

  /** Resolve a still-`offered` row the caller has locked. false ⇒ it was not live. */
  async resolveLive(
    tx: DrizzleTx,
    offerId: string,
    to: Extract<DispatchOfferState, 'accepted' | 'expired' | 'revoked'>,
  ): Promise<boolean> {
    const res = await tx.execute(sql`
      UPDATE dispatch_offer SET state = ${to}, resolved_at = clock_timestamp()
       WHERE id = ${offerId} AND state = 'offered'
       RETURNING id`);
    return res.rows.length > 0;
  }

  /** One guarded UPDATE: only the offer's own driver, only while it is live. */
  async decline(db: DbExecutor, offerId: string, driverId: string): Promise<DeclineOfferResult> {
    if (!isUuid(offerId) || !isUuid(driverId)) return 'not_found';
    const res = await db.execute<{ declined: boolean; found: boolean }>(sql`
      WITH upd AS (
        UPDATE dispatch_offer SET state = 'declined', resolved_at = clock_timestamp()
         WHERE id = ${offerId} AND driver_id = ${driverId} AND state = 'offered'
         RETURNING id)
      SELECT EXISTS (SELECT 1 FROM upd) AS declined,
             EXISTS (SELECT 1 FROM dispatch_offer
                      WHERE id = ${offerId} AND driver_id = ${driverId}) AS found`);
    const row = res.rows[0];
    if (row?.declined) return 'declined';
    return row?.found ? 'not_live' : 'not_found';
  }

  /**
   * Revoke every live offer for the trip (all generations), except the winner.
   * The caller holds the trip row lock (contract §1.3 step 2).
   */
  async revokeLiveForTrip(
    tx: DbExecutor,
    trip: TripRef,
    exceptOfferId?: string,
  ): Promise<Array<{ offerId: string; driverId: string }>> {
    const except = exceptOfferId ? sql` AND id <> ${exceptOfferId}` : sql``;
    const res = await tx.execute<{ id: string; driver_id: string }>(sql`
      UPDATE dispatch_offer SET state = 'revoked', resolved_at = clock_timestamp()
       WHERE ${offerTripPredicate(trip)} AND state = 'offered'${except}
       RETURNING id, driver_id`);
    return res.rows.map((r) => ({ offerId: r.id, driverId: r.driver_id }));
  }

  /** Sweeper + boot: mark lapsed live offers `expired`. Never waits on a locked row. */
  async expireLapsed(db: DbExecutor): Promise<number> {
    const res = await db.execute(sql`
      UPDATE dispatch_offer SET state = 'expired', resolved_at = clock_timestamp()
       WHERE id IN (SELECT id FROM dispatch_offer
                     WHERE state = 'offered' AND expires_at <= clock_timestamp()
                     FOR UPDATE SKIP LOCKED)
       RETURNING id`);
    return res.rows.length;
  }

  /** Drivers already offered this trip generation (they are never re-offered it). */
  async offeredDriverIds(db: DbExecutor, trip: TripRef, generation: number): Promise<string[]> {
    const res = await db.execute<{ driver_id: string }>(sql`
      SELECT driver_id FROM dispatch_offer
       WHERE ${offerTripPredicate(trip)} AND dispatch_generation = ${generation}`);
    return res.rows.map((r) => r.driver_id);
  }

  /**
   * Advisory filter over geo-index candidates, keeping input (distance) order.
   * Drops: non-UUID members, no `driver` row, app_user not an active driver,
   * an existing active assignment, a live offer, and no active vehicle with
   * `seats ≥ seatsNeeded`. The accept transaction re-checks all of it.
   */
  async eligibleCandidates(
    db: DbExecutor,
    candidateIds: string[],
    seatsNeeded: number,
  ): Promise<string[]> {
    const ids = [...new Set(candidateIds.filter(isUuid))];
    if (ids.length === 0) return [];
    const res = await db.execute<{ id: string }>(sql`
      SELECT c.id::text AS id
        FROM unnest(${uuidArray(ids)}::uuid[]) WITH ORDINALITY AS c(id, ord)
        JOIN app_user u ON u.id = c.id AND u.status = 'active' AND u.role = 'driver'
        JOIN driver d ON d.user_id = c.id
       WHERE NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.driver_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM dispatch_offer o
                          WHERE o.driver_id = c.id AND o.state = 'offered'
                            AND o.expires_at > clock_timestamp())
         AND EXISTS (SELECT 1 FROM vehicle v
                      WHERE v.driver_id = c.id AND v.active AND v.seats >= ${seatsNeeded})
       ORDER BY c.ord`);
    return res.rows.map((r) => r.id);
  }
}
