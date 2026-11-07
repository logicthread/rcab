import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { rides } from '../../db/schema';
import { RidesRepository, type RideRow } from '../rides/rides.repository';
import { SharedRideRepository, type SharedRideRow } from '../matching/shared-ride.repository';
import { DispatchService } from './dispatch.service';

export type StartOutcome = 'started' | 'stale';

/**
 * The slice of `DispatchService` the start path needs (slice A owns the real
 * signatures: contract §2.2). Depending on the structural type keeps this
 * service decoupled from the rest of the dispatch internals and lets tests
 * inject a fake that fails or blocks at a chosen point.
 */
export interface WaveRunner {
  runSoloWave(ride: RideRow, waveNumber: 1 | 2, generation: number): Promise<void>;
  runPoolWave(pool: SharedRideRow, waveNumber: 1 | 2, generation: number): Promise<void>;
}

/**
 * Worker-side entry points that begin a dispatch generation (R07). The BullMQ
 * job that calls these completes only when the returned promise resolves, i.e.
 * after wave 1 wrote its offers and armed its timers, and a failure propagates
 * so BullMQ retries the job instead of swallowing it (F08).
 *
 * Every method is a state/generation guard first: BullMQ delivers at least
 * once, the relay can publish twice, and a cancelled/claimed/superseded trip
 * must turn a stale job into a no-op rather than an error or a second dispatch.
 */
@Injectable()
export class DispatchStartService {
  private readonly log = new Logger(DispatchStartService.name);

  constructor(
    private readonly ridesRepo: RidesRepository,
    private readonly sharedRepo: SharedRideRepository,
    @Inject(DispatchService) private readonly waves: WaveRunner,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
  ) {}

  /** Start (or safely re-run) wave 1 for a solo ride at `generation`. */
  async startSolo(rideId: string, generation: number): Promise<StartOutcome> {
    const ride = await this.ridesRepo.findById(rideId);
    if (!ride || ride.status !== 'requested' || ride.dispatchGeneration !== generation) {
      this.log.log(
        { rideId, generation, status: ride?.status, current: ride?.dispatchGeneration },
        'startSolo: stale job; nothing to do',
      );
      return 'stale';
    }
    // Errors propagate: the job retries, and wave 1 is idempotent per generation.
    await this.waves.runSoloWave(ride, 1, generation);
    return 'started';
  }

  /** Start (or safely re-run) wave 1 for a closed, unclaimed pool at `generation`. */
  async startPool(poolId: string, generation: number): Promise<StartOutcome> {
    const pool = await this.sharedRepo.findById(poolId);
    const dispatchable =
      pool &&
      (pool.poolState === 'closed_full' || pool.poolState === 'closed_timeout') &&
      !pool.claimedByDriverId &&
      pool.dispatchGeneration === generation;
    if (!pool || !dispatchable) {
      this.log.log(
        { poolId, generation, state: pool?.poolState, current: pool?.dispatchGeneration },
        'startPool: stale job; nothing to do',
      );
      return 'stale';
    }
    await this.waves.runPoolWave(pool, 1, generation);
    return 'started';
  }

  /**
   * The scheduled wake (T minus lead): record generation `generation` on a ride
   * that is still an un-woken `requested` scheduled ride, then run the normal
   * dispatch start. The single guarded UPDATE is the cancel boundary (T26): the
   * cancel transaction holds the ride's row lock, so either cancel wins (this
   * UPDATE re-checks `status` after the lock releases and matches nothing) or
   * the wake wins and cancel then cancels a ride that dispatch is working on,
   * which the ordinary cancel path already unwinds. `IN (g-1, g)` makes a
   * redelivered wake (already at `g`) re-run wave 1 idempotently while a wake
   * for a generation that was already superseded matches nothing.
   */
  async wakeScheduled(rideId: string, generation: number): Promise<StartOutcome> {
    const woken = await this.db
      .update(rides)
      .set({ dispatchGeneration: generation, updatedAt: sql`now()` })
      .where(
        and(
          eq(rides.id, rideId),
          eq(rides.type, 'scheduled'),
          eq(rides.status, 'requested'),
          inArray(rides.dispatchGeneration, [generation - 1, generation]),
        ),
      )
      .returning({ id: rides.id });
    if (woken.length === 0) {
      this.log.log({ rideId, generation }, 'wakeScheduled: ride cancelled/claimed/superseded; no-op');
      return 'stale';
    }
    return this.startSolo(rideId, generation);
  }
}
