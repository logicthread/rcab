import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { getNumber } from '../../common/utils/env';
import { DRIZZLE_DB, type DrizzleDb, type DrizzleTx } from '../../infra/db/drizzle.module';
import { RealtimeBus } from '../realtime/realtime.bus';
import { enqueueOutbox } from '../outbox/outbox.writer';
import { OutboxRelay } from '../outbox/outbox.relay';
import { OutboxTopic } from '../outbox/outbox.types';
import { IdempotencyRepository, type IdempotencyScope } from '../rides/idempotency.repository';
import { computeStops } from './itinerary';
import {
  PoolMembershipRepository,
  type InsertMemberFailure,
  type PoolLockRow,
} from './pool-membership.repository';
import { PoolProjectionService } from './pool-projection.service';
import type { SeatFareQuoter, SeatQuote } from '../pricing/pricing.types';
import {
  SharedRideRepository,
  type SharedRideMember,
  type SharedRideRow,
} from './shared-ride.repository';

export const MATCHING_QUEUE = 'matching';
export const POOL_EXPIRE_JOB = 'pool:expire';
export const POOL_UPDATE_EVENT = 'pool:update';

export interface PoolUpdatePayload {
  sharedRideId: string;
  seatCount: number;
  poolStatus: 'open' | 'closed_full' | 'closed_timeout';
}

export type PoolCloseReason = 'closed_full' | 'closed_timeout' | 'closed_started' | 'aborted';

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

/**
 * What a committed seat looks like to the caller (and to its idempotency
 * record). `quote` is the fare the passenger agreed to, priced and persisted in
 * the same transaction as the seat (SHARED_FARE_POLICY = fixed_at_join).
 */
export interface SeatOutcome {
  sharedRideId: string;
  mode: 'opened' | 'slotted';
  poolStatus: 'open' | 'closed_full';
  seatCount: number;
  quote: SeatQuote;
}

/**
 * Shared-create idempotency, completed INSIDE the seat transaction: the seat
 * row stores `scope.key`, and the claim flips to `completed` with
 * `response(outcome)` in the same commit (closes the Stage-B TODO(R08)).
 */
export interface SeatIdempotency {
  scope: IdempotencyScope;
  response: (outcome: SeatOutcome) => unknown;
}

/**
 * `openPool` rolled back without creating anything: the opener already holds a
 * seat in another live pool, the idempotency key already produced a seat
 * (`existingPoolId`), or the bounded deadlock retry was exhausted.
 */
export class PoolOpenRejectedError extends Error {
  constructor(
    readonly reason: 'passenger_has_active_pool' | 'idempotent_replay' | 'conflict',
    readonly existingPoolId?: string,
  ) {
    super(`openPool rejected: ${reason}`);
    this.name = 'PoolOpenRejectedError';
  }
}

export type JoinPoolResult =
  | { joined: true; closedFull: boolean; seatCount: number; quote: SeatQuote }
  | {
      joined: false;
      reason: InsertMemberFailure | 'not_found' | 'conflict';
      existingPoolId?: string;
    };

export type CloseIfOpenResult = 'closed' | 'not_open' | 'aborted_empty';

/** 40P01 deadlock / 40001 serialization: retry the whole transaction (≤ 2 retries). */
const RETRYABLE_TX_CODES = new Set(['40P01', '40001']);
const MAX_TX_RETRIES = 2;

function pgErrorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Pool membership, capacity and closure as ONE Postgres transaction per change
 * (F09 / F15, R08). The `shared_rides` row lock serializes every writer of a
 * pool; `pool_member` + triggers enforce membership/capacity/open-state even
 * for a writer that forgot to lock. Closure is a guarded `open → closed_*`
 * transition that, in the same commit, bumps the dispatch generation, persists
 * the itinerary to `ride_stops` and records the `pool.dispatch.requested`
 * outbox intent. Redis (`pool:<id>`), socket rooms and `pool:update` emits are
 * post-commit, best-effort, and rebuilt from Postgres when they fail.
 */
@Injectable()
export class PoolLifecycleService {
  private readonly log = new Logger(PoolLifecycleService.name);
  private readonly poolTimeoutMs: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly repo: SharedRideRepository,
    private readonly members: PoolMembershipRepository,
    private readonly projection: PoolProjectionService,
    private readonly idempotency: IdempotencyRepository,
    private readonly relay: OutboxRelay,
    private readonly bus: RealtimeBus,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.poolTimeoutMs = getNumber(config, 'MATCHING_POOL_TIMEOUT_MS', 60_000, {
      integer: true,
      min: 1,
    });
  }

  /**
   * ONE txn: INSERT the open pool (seat_count 0, planned close = now() +
   * MATCHING_POOL_TIMEOUT_MS on the DB clock) → seat the opener → outbox
   * `pool.expire.schedule` g0 → idempotency complete. A rejected opener (already
   * holds an active seat / replayed key) rolls the whole pool back and throws
   * `PoolOpenRejectedError`. Returns the committed row (re-read after commit).
   */
  async openPool(
    p: OpenPoolParams & {
      /** Prices the opener's seat INSIDE the transaction; a throw rolls the pool back. */
      quoteFare: SeatFareQuoter;
      idempotency?: SeatIdempotency;
      /** Pre-generated id (lets the caller quote against it); random otherwise. */
      poolId?: string;
    },
  ): Promise<SharedRideRow & { quote: SeatQuote }> {
    const poolId = p.poolId ?? randomUUID();
    const committed = await this.inTx<{
      seatCount: number;
      poolClosedAt: Date;
      quote: SeatQuote;
    } | null>(
      async (tx) => {
        const { poolClosedAt } = await this.repo.insertOpenPool(tx, {
          rideId: poolId,
          originLat: p.originLat,
          originLng: p.originLng,
          destLat: p.destLat,
          destLng: p.destLng,
          maxSeats: p.maxSeats,
          detourBudgetM: p.detourBudgetM,
          timeoutMs: this.poolTimeoutMs,
        });
        const quote = await p.quoteFare({
          poolId,
          passengerId: p.passengerId,
          seatCount: 1,
          directRoute: {
            originLat: p.originLat,
            originLng: p.originLng,
            destLat: p.destLat,
            destLng: p.destLng,
          },
          stops: computeStops({
            originLat: p.originLat,
            originLng: p.originLng,
            members: [
              {
                passenger_id: p.passengerId,
                origin_lat: p.originLat,
                origin_lng: p.originLng,
                dest_lat: p.destLat,
                dest_lng: p.destLng,
                joined_at: new Date().toISOString(),
              },
            ],
          }),
        });
        const seat = await this.members.insertMember(tx, {
          poolId,
          passengerId: p.passengerId,
          originLat: p.originLat,
          originLng: p.originLng,
          destLat: p.destLat,
          destLng: p.destLng,
          agreedFareCents: quote.perSeatPrice.amount,
          idempotencyKey: p.idempotency?.scope.key ?? null,
        });
        if (!seat.ok) {
          if (seat.reason === 'passenger_has_active_pool' || seat.reason === 'idempotent_replay') {
            throw new PoolOpenRejectedError(seat.reason, seat.existingPoolId);
          }
          // pool_full / pool_closed / already_member cannot happen for a pool
          // this transaction just created — treat as a bug.
          throw new Error(`openPool: unexpected opener rejection ${seat.reason}`);
        }
        await enqueueOutbox(tx, {
          topic: OutboxTopic.PoolExpireSchedule,
          aggregateType: 'shared_ride',
          aggregateId: poolId,
          generation: 0,
          payload: { expireAt: poolClosedAt.toISOString() },
        });
        if (p.idempotency) {
          await this.idempotency.completeIn(
            tx,
            p.idempotency.scope,
            poolId,
            p.idempotency.response({
              sharedRideId: poolId,
              mode: 'opened',
              poolStatus: 'open',
              seatCount: seat.seatCount,
              quote,
            }),
          );
        }
        return { seatCount: seat.seatCount, poolClosedAt, quote };
      },
      () => null,
    );
    if (committed === null) throw new PoolOpenRejectedError('conflict');

    const row = await this.afterCommit(poolId, { joinPassengerId: p.passengerId, kickRelay: true });
    const quote = committed.quote;
    return {
      ...(row ?? {
        // Post-commit re-read failed: describe the committed pool from the txn.
        rideId: poolId,
        seatCount: committed.seatCount,
        maxSeats: p.maxSeats,
        poolState: 'open',
        poolClosedAt: committed.poolClosedAt,
        detourBudgetM: p.detourBudgetM,
        originLat: p.originLat,
        originLng: p.originLng,
        destLat: p.destLat,
        destLng: p.destLng,
        members: [
          {
            passenger_id: p.passengerId,
            origin_lat: p.originLat,
            origin_lng: p.originLng,
            dest_lat: p.destLat,
            dest_lng: p.destLng,
            joined_at: new Date().toISOString(),
          },
        ],
        claimedByDriverId: null,
        claimedAt: null,
        dispatchGeneration: 0,
        stateVersion: 0,
      }),
      quote,
    };
  }

  /**
   * ONE txn: lock the pool → re-validate open + free capacity (candidate
   * discovery was advisory) → price the seat from the locked state (Phase-0
   * stand-in SHARED_FARE_POLICY = fixed_at_join: seat count after this join,
   * itinerary incl. the joiner; earlier members are never repriced; a pricing
   * failure throws and rolls everything back) → insert the member with its
   * agreed fare (the DB re-checks everything)
   * → close `closed_full` in the same txn when this seat filled it →
   * idempotency complete. Typed failures leave the pool untouched.
   */
  async joinPool(p: {
    poolId: string;
    joiner: SharedRideMember;
    /**
     * Prices the joiner's seat INSIDE the transaction, from the locked pool
     * state (seat count after this join, itinerary including the joiner). A
     * throw rolls the join back: a seat is never committed without its fare.
     */
    quoteFare: SeatFareQuoter;
    idempotency?: SeatIdempotency;
  }): Promise<JoinPoolResult> {
    const result = await this.inTx<JoinPoolResult>(
      async (tx) => {
        const pool = await this.members.lockPool(tx, p.poolId);
        if (!pool) return { joined: false, reason: 'not_found' };
        if (pool.poolState !== 'open') return { joined: false, reason: 'pool_closed' };
        if (pool.seatCount >= pool.maxSeats) return { joined: false, reason: 'pool_full' };

        // Fixed-at-join fare (SHARED_FARE_POLICY): priced from the LOCKED state
        // so a concurrent join cannot change the seat count under the quote.
        // Earlier members' fares are never touched.
        const existing = await this.members.listMembers(tx, p.poolId);
        const quote = await p.quoteFare({
          poolId: p.poolId,
          passengerId: p.joiner.passenger_id,
          seatCount: pool.seatCount + 1,
          directRoute: {
            originLat: p.joiner.origin_lat,
            originLng: p.joiner.origin_lng,
            destLat: p.joiner.dest_lat,
            destLng: p.joiner.dest_lng,
          },
          stops: computeStops({
            originLat: pool.originLat,
            originLng: pool.originLng,
            members: [
              ...existing.filter((m) => m.passenger_id !== p.joiner.passenger_id),
              p.joiner,
            ],
          }),
        });
        const seat = await this.members.insertMember(tx, {
          poolId: p.poolId,
          passengerId: p.joiner.passenger_id,
          originLat: p.joiner.origin_lat,
          originLng: p.joiner.origin_lng,
          destLat: p.joiner.dest_lat,
          destLng: p.joiner.dest_lng,
          agreedFareCents: quote.perSeatPrice.amount,
          idempotencyKey: p.idempotency?.scope.key ?? null,
        });
        if (!seat.ok) {
          return { joined: false, reason: seat.reason, existingPoolId: seat.existingPoolId };
        }

        let closedFull = false;
        if (seat.seatCount >= pool.maxSeats) {
          closedFull = (await this.closeInTxn(tx, pool, 'closed_full')) !== null;
        }
        if (p.idempotency) {
          await this.idempotency.completeIn(
            tx,
            p.idempotency.scope,
            p.poolId,
            p.idempotency.response({
              sharedRideId: p.poolId,
              mode: 'slotted',
              poolStatus: closedFull ? 'closed_full' : 'open',
              seatCount: seat.seatCount,
              quote,
            }),
          );
        }
        return { joined: true, closedFull, seatCount: seat.seatCount, quote };
      },
      () => ({ joined: false, reason: 'conflict' }),
    );

    if (result.joined) {
      await this.afterCommit(p.poolId, {
        joinPassengerId: p.joiner.passenger_id,
        kickRelay: result.closedFull,
      });
    }
    return result;
  }

  /**
   * Timeout close (the `pool:expire` worker). Takes the same pool lock as
   * joiners; a stale timeout on a pool that is already closed/started/finished
   * is a no-op. Errors propagate so the job retries.
   */
  async closeIfOpen(poolId: string, reason: 'closed_timeout'): Promise<CloseIfOpenResult> {
    const result = await this.inTx<CloseIfOpenResult | 'conflict'>(
      async (tx) => {
        const pool = await this.members.lockPool(tx, poolId);
        if (!pool || pool.poolState !== 'open') return 'not_open';
        if (pool.seatCount === 0) {
          return (await this.repo.abortEmptyOpen(tx, poolId)) ? 'aborted_empty' : 'not_open';
        }
        return (await this.closeInTxn(tx, pool, reason)) === null ? 'not_open' : 'closed';
      },
      () => 'conflict',
    );
    if (result === 'conflict') {
      throw new Error(`closeIfOpen(${poolId}): transaction retries exhausted`);
    }
    if (result === 'closed') {
      await this.afterCommit(poolId, { joinPassengerId: null, kickRelay: true });
    } else if (result === 'aborted_empty') {
      this.log.warn({ poolId }, 'open pool with no members timed out → aborted');
      await this.afterCommit(poolId, { joinPassengerId: null, kickRelay: false });
    }
    return result;
  }

  /**
   * Guarded `open → closed_*` inside the caller's txn (pool row already
   * locked): bump generation, persist the itinerary from the committed member
   * set, record the dispatch intent. Returns the new generation, or null when
   * the pool was not open.
   */
  private async closeInTxn(
    tx: DrizzleTx,
    pool: PoolLockRow,
    reason: 'closed_full' | 'closed_timeout',
  ): Promise<number | null> {
    const closed = await this.repo.closeOpen(tx, pool.poolId, reason);
    if (!closed) return null;
    const members = await this.members.listMembers(tx, pool.poolId);
    const stops = computeStops({ originLat: pool.originLat, originLng: pool.originLng, members });
    await this.members.insertItinerary(tx, pool.poolId, stops);
    await enqueueOutbox(tx, {
      topic: OutboxTopic.PoolDispatchRequested,
      aggregateType: 'shared_ride',
      aggregateId: pool.poolId,
      generation: closed.generation,
      payload: { poolId: pool.poolId, reason },
    });
    return closed.generation;
  }

  /** db.transaction with bounded retry on deadlock / serialization failure. */
  private async inTx<T>(fn: (tx: DrizzleTx) => Promise<T>, onConflict: () => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(fn);
      } catch (err) {
        const code = pgErrorCode(err);
        if (code === null || !RETRYABLE_TX_CODES.has(code)) throw err;
        if (attempt >= MAX_TX_RETRIES) {
          this.log.warn({ code, attempt }, 'pool transaction retries exhausted');
          return onConflict();
        }
      }
    }
  }

  /**
   * Post-commit, best-effort: project Redis from the committed row, join the
   * passenger's sockets to the pool room, emit `pool:update` from the committed
   * row. Nothing here may turn a committed success into an error.
   */
  private async afterCommit(
    poolId: string,
    opts: {
      joinPassengerId: string | null;
      /** An outbox row committed (expiry schedule / dispatch intent): drain it now. */
      kickRelay: boolean;
    },
  ): Promise<SharedRideRow | null> {
    let row: SharedRideRow | null = null;
    try {
      row = await this.repo.findById(poolId);
    } catch (err) {
      this.log.warn({ err, poolId }, 'post-commit pool re-read failed');
    }
    if (row) {
      try {
        await this.projection.write(row);
      } catch (err) {
        this.log.warn({ err, poolId }, 'pool projection failed; rebuild will repair');
      }
    }
    if (opts.joinPassengerId) {
      await this.bus.joinPool(opts.joinPassengerId, poolId).catch((err: unknown) => {
        this.log.warn({ err, poolId }, 'joinPool socket room failed');
      });
    }
    if (row) this.emitPoolUpdate(row);
    if (opts.kickRelay) {
      // Latency only: the relay's poll loop is the backstop for the durable row.
      try {
        this.relay.kick();
      } catch (err) {
        this.log.warn({ err, poolId }, 'outbox relay kick failed (intent is durable)');
      }
    }
    return row;
  }

  private emitPoolUpdate(row: SharedRideRow): void {
    const status = row.poolState;
    if (status !== 'open' && status !== 'closed_full' && status !== 'closed_timeout') return;
    try {
      this.bus.toPool(row.rideId, POOL_UPDATE_EVENT, {
        sharedRideId: row.rideId,
        seatCount: row.seatCount,
        poolStatus: status,
      } satisfies PoolUpdatePayload);
    } catch (err) {
      this.log.warn({ err, poolId: row.rideId }, 'emitPoolUpdate failed');
    }
  }
}
