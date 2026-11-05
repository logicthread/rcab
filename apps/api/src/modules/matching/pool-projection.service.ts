import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { SharedRideRepository, type SharedRideRow } from './shared-ride.repository';

export const POOL_HASH_TTL_SECONDS = 600;

export function poolHashKey(poolId: string): string {
  return `pool:${poolId}`;
}

/**
 * Compare-version write of the `pool:<id>` projection. Writes only when the
 * stored `version` is absent or older than the incoming `shared_rides.
 * state_version`, so a slow writer can never roll the projection back.
 * `claimed_by` is only ever set (a pool is never un-claimed), never deleted.
 *
 * KEYS[1] pool:<id>
 * ARGV    version, state, seat_count, max_seats, claimed_by|'' , ttl_s
 * Returns 1 written, 0 skipped (stored version is current or newer).
 */
const PROJECT_POOL_EVAL = `
local cur = redis.call('HGET', KEYS[1], 'version')
if cur and tonumber(cur) and tonumber(cur) >= tonumber(ARGV[1]) then
  return 0
end
redis.call('HSET', KEYS[1], 'version', ARGV[1], 'state', ARGV[2], 'seat_count', ARGV[3], 'max_seats', ARGV[4])
if ARGV[5] ~= '' then
  redis.call('HSET', KEYS[1], 'claimed_by', ARGV[5])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
return 1
`;

/**
 * Redis `pool:<id>` hash = a rebuildable projection of Postgres (`shared_rides`
 * + `pool_member`), never an authority (F09 / R08). Written after commit only;
 * a failed write is logged and repaired by the next `project` / `rebuildAll`.
 */
@Injectable()
export class PoolProjectionService implements OnApplicationBootstrap {
  private readonly log = new Logger(PoolProjectionService.name);

  constructor(
    private readonly pools: SharedRideRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await this.rebuildAll();
      this.log.log({ pools: n }, 'pool projection rebuilt from Postgres');
    } catch (err) {
      this.log.error({ err }, 'pool projection rebuild failed');
    }
  }

  /** Re-read the committed pool and write its projection. Returns the row read (or null). */
  async project(poolId: string): Promise<SharedRideRow | null> {
    const pool = await this.pools.findById(poolId);
    if (!pool) return null;
    await this.write(pool);
    return pool;
  }

  /** Project every non-terminal pool (boot, or after Redis loss). */
  async rebuildAll(): Promise<number> {
    const ids = await this.pools.listNonTerminalIds();
    let n = 0;
    for (const id of ids) {
      if (await this.project(id)) n++;
    }
    return n;
  }

  /** Write a committed row; true when the projection advanced. */
  async write(pool: SharedRideRow): Promise<boolean> {
    const written = await this.redis.eval(
      PROJECT_POOL_EVAL,
      1,
      poolHashKey(pool.rideId),
      String(pool.stateVersion),
      pool.poolState,
      String(pool.seatCount),
      String(pool.maxSeats),
      pool.claimedByDriverId ?? '',
      String(POOL_HASH_TTL_SECONDS),
    );
    return Number(written) === 1;
  }
}
