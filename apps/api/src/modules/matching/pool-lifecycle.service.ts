import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { POLICY, type Policy } from '../../config/policy/policy';
import { DRIZZLE_DB, type DrizzleDb, type DrizzleTx } from '../../infra/db/drizzle.module';
import { RealtimeBus } from '../realtime/realtime.bus';
import {
  POOL_UPDATE,
  poolUpdatePayload,
  type PoolUpdatePayload,
} from '../realtime/realtime.protocol';
import { enqueueOutbox } from '../outbox/outbox.writer';
import { OutboxRelay } from '../outbox/outbox.relay';
import { OutboxTopic } from '../outbox/outbox.types';
import { IdempotencyRepository, type IdempotencyScope } from '../rides/idempotency.repository';
import { poolClosures, poolJoins } from '../../metrics';
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
export const POOL_UPDATE_EVENT = POOL_UPDATE;

/** The versioned, member-visible pool event (R09) — see realtime.protocol.ts. */
export type { PoolUpdatePayload };

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
 * record). `quote` is the fare the passenger agreed to: priced BEFORE the seat
 * transaction (optimistically, no lock held) and persisted in the same
 * transaction as the seat, only if the pool is unchanged since it was priced
 * (SHARED_FARE_POLICY = fixed_at_join).
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
 *
 * Seat pricing is OPTIMISTIC and never runs under that lock (RCAB-E8.S13): the
 * fare is quoted (OSRM / Redis) from an unlocked snapshot of the pool, and the
 * transaction only commits it if `state_version` is unchanged after
 * `FOR UPDATE`; otherwise the attempt is discarded and re-priced (bounded by
 * `matching.joinPriceRetries`). The lock is therefore held for a handful of
 * local statements, never for a network call.
 */
@Injectable()
export class PoolLifecycleService {
  private readonly log = new Logger(PoolLifecycleService.name);
  private readonly poolTimeoutMs: number;
  private readonly joinPriceRetries: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly repo: SharedRideRepository,
    private readonly members: PoolMembershipRepository,
    private readonly projection: PoolProjectionService,
    private readonly idempotency: IdempotencyRepository,
    private readonly relay: OutboxRelay,
    private readonly bus: RealtimeBus,
    @Inject(POLICY) policy: Policy,
  ) {
    this.poolTimeoutMs = policy.matching.poolTimeoutMs;
    this.joinPriceRetries = policy.matching.joinPriceRetries;
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
      /**
       * Prices the opener's seat BEFORE the transaction (nothing about a brand
       * new pool needs a lock); a throw creates nothing.
       */
      quoteFare: SeatFareQuoter;
      idempotency?: SeatIdempotency;
      /** Pre-generated id (lets the caller quote against it); random otherwise. */
      poolId?: string;
    },
  ): Promise<SharedRideRow & { quote: SeatQuote }> {
    const poolId = p.poolId ?? randomUUID();
    // Priced OUTSIDE the transaction: a brand-new pool has no concurrent state
    // to go stale, so there is nothing to validate and no reason for a routing
    // call to sit inside a transaction. A routing failure creates nothing.
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
    const committed = await this.inTx<{
      seatCount: number;
      poolClosedAt: Date;
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
        return { seatCount: seat.seatCount, poolClosedAt };
      },
      () => null,
    ).catch((err: unknown) => {
      // A refusal creates nothing; count it by its typed reason (bounded set).
      if (err instanceof PoolOpenRejectedError) poolJoins.inc({ result: err.reason });
      throw err;
    });
    if (committed === null) {
      poolJoins.inc({ result: 'conflict' });
      throw new PoolOpenRejectedError('conflict');
    }
    poolJoins.inc({ result: 'opened' });

    const row = await this.afterCommit(poolId, { joinPassengerId: p.passengerId, kickRelay: true });
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
   * Optimistic seat pricing + ONE short txn.
   *
   *  1. Read an UNLOCKED snapshot (pool row + members). Doomed joins (missing /
   *     closed / full) fail here without any routing call.
   *  2. Price the seat from the snapshot — seat count after this join, the
   *     itinerary including the joiner — via `quoteFare` (OSRM), with NO
   *     transaction open and no lock held (SHARED_FARE_POLICY = fixed_at_join:
   *     earlier members are never repriced; a pricing failure throws before
   *     anything is written, so a seat is never committed without its fare).
   *  3. txn: lock the pool (`FOR UPDATE`) → re-validate open + capacity → if
   *     `state_version` moved since the snapshot the quote may describe a
   *     different member set, so discard it and go back to 1 (≤
   *     `matching.joinPriceRetries` retries) → else insert the member with the
   *     precomputed agreed fare (the DB re-checks everything) → close
   *     `closed_full` in the same txn when this seat filled it → idempotency
   *     complete. Typed failures leave the pool untouched.
   *
   * Version equality under the lock means the member set (hence the itinerary
   * and seat count) is exactly what was priced, so the stored fare is what the
   * committed itinerary implies. When the retries are exhausted the result is
   * the typed `conflict`: `MatchingService` treats it like any stale candidate
   * (try the next pool, else open a new one) — the natural existing semantics
   * for a pool that is too contended to price against.
   */
  async joinPool(p: {
    poolId: string;
    joiner: SharedRideMember;
    /**
     * Prices the joiner's seat from an unlocked pool snapshot (seat count after
     * this join, itinerary including the joiner). Runs OUTSIDE any transaction
     * and may be called more than once per join; a throw aborts the join before
     * any write.
     */
    quoteFare: SeatFareQuoter;
    idempotency?: SeatIdempotency;
  }): Promise<JoinPoolResult> {
    // Every outcome is counted once (a typed refusal wrote nothing, a join committed a seat).
    const done = (r: JoinPoolResult): JoinPoolResult => {
      poolJoins.inc({ result: r.joined ? 'joined' : r.reason });
      if (r.joined && r.closedFull) poolClosures.inc({ reason: 'closed_full' });
      return r;
    };
    for (let attempt = 0; attempt <= this.joinPriceRetries; attempt++) {
      const snap = await this.members.snapshotPool(this.db, p.poolId);
      if (!snap) return done({ joined: false, reason: 'not_found' });
      if (snap.pool.poolState !== 'open') return done({ joined: false, reason: 'pool_closed' });
      if (snap.pool.seatCount >= snap.pool.maxSeats) return done({ joined: false, reason: 'pool_full' });

      // No transaction is open here: a slow OSRM cannot hold any pool lock.
      const quote = await p.quoteFare({
        poolId: p.poolId,
        passengerId: p.joiner.passenger_id,
        seatCount: snap.pool.seatCount + 1,
        directRoute: {
          originLat: p.joiner.origin_lat,
          originLng: p.joiner.origin_lng,
          destLat: p.joiner.dest_lat,
          destLng: p.joiner.dest_lng,
        },
        stops: computeStops({
          originLat: snap.pool.originLat,
          originLng: snap.pool.originLng,
          members: [
            ...snap.members.filter((m) => m.passenger_id !== p.joiner.passenger_id),
            p.joiner,
          ],
        }),
      });

      const outcome = await this.inTx<{ stale: true } | { stale: false; result: JoinPoolResult }>(
        async (tx) => {
          const pool = await this.members.lockPool(tx, p.poolId);
          if (!pool) return { stale: false, result: { joined: false, reason: 'not_found' } };
          if (pool.poolState !== 'open') {
            return { stale: false, result: { joined: false, reason: 'pool_closed' } };
          }
          if (pool.seatCount >= pool.maxSeats) {
            return { stale: false, result: { joined: false, reason: 'pool_full' } };
          }
          // The quote is only valid for the exact state it was priced against.
          if (pool.stateVersion !== snap.pool.stateVersion) return { stale: true };

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
            return {
              stale: false,
              result: { joined: false, reason: seat.reason, existingPoolId: seat.existingPoolId },
            };
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
          return {
            stale: false,
            result: { joined: true, closedFull, seatCount: seat.seatCount, quote },
          };
        },
        () => ({ stale: false, result: { joined: false, reason: 'conflict' } }),
      );

      if (outcome.stale) {
        this.log.debug(
          { poolId: p.poolId, attempt },
          'pool changed while pricing the seat; re-pricing',
        );
        continue;
      }
      const result = outcome.result;
      if (result.joined) {
        await this.afterCommit(p.poolId, {
          joinPassengerId: p.joiner.passenger_id,
          kickRelay: result.closedFull,
        });
      }
      return done(result);
    }

    this.log.warn(
      { poolId: p.poolId, retries: this.joinPriceRetries },
      'pool kept changing while pricing the seat; join gives up (conflict)',
    );
    return done({ joined: false, reason: 'conflict' });
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
      poolClosures.inc({ reason: 'closed_timeout' });
      await this.afterCommit(poolId, { joinPassengerId: null, kickRelay: true });
    } else if (result === 'aborted_empty') {
      poolClosures.inc({ reason: 'aborted_empty' });
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
      // Built from the committed row; `version` (= state_version) lets members
      // drop duplicates / reordered deliveries and reconcile with snapshots.
      this.bus.toPool(row.rideId, POOL_UPDATE_EVENT, poolUpdatePayload(row));
    } catch (err) {
      this.log.warn({ err, poolId: row.rideId }, 'emitPoolUpdate failed');
    }
  }
}
