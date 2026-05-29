import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import {
  SharedRideRepository,
  type SharedRideMember,
  type SharedRideRow,
} from './shared-ride.repository';

export const MATCHING_QUEUE = 'matching';
export const POOL_EXPIRE_JOB = 'pool:expire';
export const POOL_CLOSED_EVENT = 'pool.closed';

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
  passengerId: string;
}

export interface SlotRequestInput {
  pool: SharedRideRow;
  joiner: SharedRideMember;
}

export interface SlotResult {
  slotted: boolean;
  closedFull: boolean;
  seatCount: number;
}

export interface PoolClosedEventPayload {
  rideId: string;
  reason: Extract<PoolCloseReason, 'closed_full' | 'closed_timeout'>;
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
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.poolTimeoutMs = config.get<number>('MATCHING_POOL_TIMEOUT_MS') ?? 60_000;
    this.poolSlotScript = readFileSync(join(__dirname, 'lua', 'pool_slot.lua'), 'utf-8');
  }

  async openPool(params: OpenPoolParams): Promise<SharedRideRow> {
    const opener: SharedRideMember = {
      passenger_id: params.passengerId,
      origin_lat:   params.originLat,
      origin_lng:   params.originLng,
      dest_lat:     params.destLat,
      dest_lng:     params.destLng,
      joined_at:    new Date().toISOString(),
    };

    const pool = await this.repo.create({
      originLat:     params.originLat,
      originLng:     params.originLng,
      destLat:       params.destLat,
      destLng:       params.destLng,
      maxSeats:      params.maxSeats,
      detourBudgetM: params.detourBudgetM,
      opener,
    });
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

  async slotRequest(input: SlotRequestInput): Promise<SlotResult> {
    const { pool, joiner } = input;
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
    await this.repo.appendMember(pool.rideId, joiner);
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

    if (reason === 'closed_full' || reason === 'closed_timeout') {
      this.events.emit(POOL_CLOSED_EVENT, { rideId, reason } satisfies PoolClosedEventPayload);
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
