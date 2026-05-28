import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { SharedRideRepository, type SharedRideRow } from './shared-ride.repository';

export const MATCHING_QUEUE = 'matching';
export const POOL_EXPIRE_JOB = 'pool:expire';

export type PoolCloseReason =
  | 'closed_full'
  | 'closed_timeout'
  | 'closed_started'
  | 'aborted';

export type PoolStatus = 'open' | PoolCloseReason;

export interface OpenPoolParams {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  maxSeats: number;
  detourBudgetM: number;
}

export interface SlotResult {
  slotted: boolean;
  closedFull: boolean;
  seatCount: number;
}

const HASH_TTL_SECONDS = 600;

@Injectable()
export class PoolLifecycleService {
  private readonly log = new Logger(PoolLifecycleService.name);
  private readonly poolTimeoutMs: number;
  private readonly poolSlotScript: string;

  constructor(
    private readonly repo: SharedRideRepository,
    @InjectQueue(MATCHING_QUEUE) private readonly queue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.poolTimeoutMs = config.get<number>('MATCHING_POOL_TIMEOUT_MS') ?? 60_000;
    this.poolSlotScript = readFileSync(join(__dirname, 'lua', 'pool_slot.lua'), 'utf-8');
  }

  async openPool(params: OpenPoolParams): Promise<SharedRideRow> {
    const pool = await this.repo.create(params);
    const jobId = expiryJobId(pool.rideId);

    await this.queue.add(
      POOL_EXPIRE_JOB,
      { rideId: pool.rideId },
      { jobId, delay: this.poolTimeoutMs, removeOnComplete: true, removeOnFail: 100 },
    );

    await this.writeHash(pool.rideId, {
      state: 'open',
      seat_count: String(pool.seatCount),
      max_seats: String(pool.maxSeats),
      expiry_job_id: jobId,
    });

    return pool;
  }

  async slotRequest(pool: SharedRideRow): Promise<SlotResult> {
    const key = `pool:${pool.rideId}:seats`;
    const result = Number(
      await this.redis.eval(
        this.poolSlotScript,
        1,
        key,
        String(pool.maxSeats),
        String(pool.seatCount),
      ),
    );

    if (result < 0) {
      return { slotted: false, closedFull: false, seatCount: pool.seatCount };
    }

    await this.repo.incrementSeats(pool.rideId, result);
    await this.writeHash(pool.rideId, { seat_count: String(result) });

    if (result >= pool.maxSeats) {
      await this.closePool(pool.rideId, 'closed_full');
      return { slotted: true, closedFull: true, seatCount: result };
    }

    return { slotted: true, closedFull: false, seatCount: result };
  }

  async closePool(rideId: string, reason: PoolCloseReason): Promise<void> {
    await this.repo.closePool(rideId, reason);
    await this.writeHash(rideId, {
      state: reason,
      closed_at: new Date().toISOString(),
    });

    if (reason !== 'closed_timeout') {
      await this.queue.remove(expiryJobId(rideId)).catch((err: unknown) => {
        this.log.warn({ err, rideId }, 'queue.remove failed for expiry job');
      });
    }
  }

  private async writeHash(rideId: string, fields: Record<string, string>): Promise<void> {
    const key = `pool:${rideId}`;
    await this.redis.hset(key, fields);
    await this.redis.expire(key, HASH_TTL_SECONDS);
  }
}

function expiryJobId(rideId: string): string {
  return `pool:expire:${rideId}`;
}
