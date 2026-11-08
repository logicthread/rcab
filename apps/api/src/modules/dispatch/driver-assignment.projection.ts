import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { DriverAssignmentRepository } from './assignment.repository';
import { DispatchOfferRepository, isUuid } from './offer.repository';
import { tripId } from './dispatch.types';
import { getPolicy } from '../../config/policy/policy';

const FIELD = 'current_ride_id';
const STATE_KEY_PREFIX = 'driver:state:';

/**
 * HSET current_ride_id only when the presence hash already exists — the
 * projection never creates `driver:state:<id>` (presence owns its existence).
 */
const SET_IF_PRESENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0`;

/** HDEL current_ride_id only when it still names the trip being released. */
const CLEAR_IF_MATCH = `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0`;

export function driverStateKey(driverId: string): string {
  return `${STATE_KEY_PREFIX}${driverId}`;
}

/** Project `current_ride_id = tripId` onto a present driver hash. 1 ⇔ written. */
export async function projectCurrentRide(
  redis: Redis,
  driverId: string,
  trip: string,
): Promise<boolean> {
  return Number(await redis.eval(SET_IF_PRESENT, 1, driverStateKey(driverId), FIELD, trip)) === 1;
}

/**
 * Compare-and-delete: clear `current_ride_id` only if it is still `trip`, so
 * completing / cancelling trip X never clears the driver's newer trip Y (F06).
 */
export async function clearCurrentRide(
  redis: Redis,
  driverId: string,
  trip: string,
): Promise<boolean> {
  return Number(await redis.eval(CLEAR_IF_MATCH, 1, driverStateKey(driverId), FIELD, trip)) === 1;
}

/**
 * Redis `driver:state:<d>.current_ride_id` is a rebuildable projection of
 * `driver_active_assignment` (Postgres is the authority). Writes happen after
 * commit and are best effort; `reconcile()` repairs drift on boot and every
 * 30 s, and also sweeps lapsed offers to `expired`.
 */
@Injectable()
export class DriverAssignmentProjection implements OnApplicationBootstrap {
  private readonly log = new Logger(DriverAssignmentProjection.name);
  private running = false;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly assignments: DriverAssignmentRepository,
    private readonly offers: DispatchOfferRepository,
  ) {}

  /** Best effort; a failure is logged and left to `reconcile()`. */
  async set(driverId: string, trip: string): Promise<void> {
    try {
      await projectCurrentRide(this.redis, driverId, trip);
    } catch (err) {
      this.log.warn({ err, driverId, trip }, 'current_ride_id projection write failed');
    }
  }

  /** Best effort compare-and-delete; a failure is logged and left to `reconcile()`. */
  async clear(driverId: string, trip: string): Promise<void> {
    try {
      await clearCurrentRide(this.redis, driverId, trip);
    } catch (err) {
      this.log.warn({ err, driverId, trip }, 'current_ride_id projection clear failed');
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.autorun()) return;
    await this.reconcileSafely();
  }

  @Interval(getPolicy().dispatch.assignmentReconcileMs)
  async onInterval(): Promise<void> {
    if (!this.autorun()) return;
    await this.reconcileSafely();
  }

  /**
   * Rebuild the projection from the guard table: every guard row is projected
   * onto its driver's present hash, and every `current_ride_id` with no
   * matching guard is cleared (compare-and-delete, so a concurrent fresh
   * projection is never wiped). Also expires lapsed offers.
   */
  async reconcile(): Promise<{ projected: number; cleared: number; expiredOffers: number }> {
    const expiredOffers = await this.offers.expireLapsed(this.db);
    const guards = await this.assignments.listAll(this.db);
    const expected = new Map(guards.map((g) => [g.driverId, tripId(g.trip)]));

    // The snapshot can age while we walk Redis (an accept / completion may
    // commit meanwhile), so every write re-confirms the driver's guard first.
    const stillAssigned = async (driverId: string, trip: string): Promise<boolean> => {
      if (!isUuid(driverId)) return false;
      const fresh = await this.assignments.findByDriver(this.db, driverId);
      return fresh !== null && tripId(fresh.trip) === trip;
    };

    let projected = 0;
    for (const [driverId, trip] of expected) {
      if ((await this.redis.hget(driverStateKey(driverId), FIELD)) === trip) continue;
      if (!(await stillAssigned(driverId, trip))) continue;
      if (await projectCurrentRide(this.redis, driverId, trip)) projected++;
    }

    let cleared = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${STATE_KEY_PREFIX}*`, 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        const driverId = key.slice(STATE_KEY_PREFIX.length);
        let current: string | null;
        try {
          current = await this.redis.hget(key, FIELD);
        } catch {
          continue; // not a hash — not ours
        }
        if (!current || expected.get(driverId) === current) continue;
        if (await stillAssigned(driverId, current)) continue;
        if (await clearCurrentRide(this.redis, driverId, current)) cleared++;
      }
    } while (cursor !== '0');

    return { projected, cleared, expiredOffers };
  }

  private autorun(): boolean {
    return process.env.RCAB_DISABLE_BULL_AUTORUN !== '1';
  }

  private async reconcileSafely(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.reconcile();
      if (r.cleared > 0 || r.expiredOffers > 0) {
        this.log.log(r, 'driver assignment projection reconciled');
      }
    } catch (err) {
      this.log.warn({ err }, 'driver assignment projection reconcile failed');
    } finally {
      this.running = false;
    }
  }
}
