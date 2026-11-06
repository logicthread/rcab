import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { RideStopRepository, type RideStopRow } from '../matching/ride-stop.repository';
import { PoolProjectionService } from '../matching/pool-projection.service';
import { DriverAssignmentRepository } from '../dispatch/assignment.repository';
import { clearCurrentRide } from '../dispatch/driver-assignment.projection';
import { RealtimeBus } from '../realtime/realtime.bus';
import {
  STOP_CONFIRM_REQUEST_EVENT,
  type StopConfirmRequestEvent,
} from '../realtime/realtime.gateway';

export type StopType = 'pickup' | 'dropoff';

export const STOP_PICKUP_EVENT = 'stop:pickup_confirmed';
export const STOP_DROP_EVENT = 'stop:drop_confirmed';
export const RIDE_COMPLETED_EVENT = 'ride:completed';

export interface StopConfirmInput {
  rideId: string;
  driverId: string;
  sequenceIndex: number;
  type: StopType;
}

export type StopConfirmResult =
  | {
      ok: true;
      stop: RideStopRow;
      pendingAfter: number;
      rideCompleted: boolean;
      /** The stop was already confirmed: this is the authoritative current state (T32). */
      duplicate: boolean;
    }
  | {
      ok: false;
      reason: 'not_found' | 'not_owner' | 'wrong_type' | 'out_of_order';
    };

type ConfirmOutcome = {
  result: StopConfirmResult;
  completedAt: Date | null;
  /** The pool row's state moved (closed_started / completed): re-project it. */
  poolStateChanged?: boolean;
};

@Injectable()
export class RideLifecycleService {
  private readonly log = new Logger(RideLifecycleService.name);

  constructor(
    private readonly stops: RideStopRepository,
    private readonly assignments: DriverAssignmentRepository,
    private readonly bus: RealtimeBus,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly poolProjection: PoolProjectionService,
  ) {}

  @OnEvent(STOP_CONFIRM_REQUEST_EVENT, { async: true })
  async onStopConfirmRequest(event: StopConfirmRequestEvent): Promise<void> {
    const result = await this.confirmStop({
      rideId: event.rideId,
      driverId: event.driverId,
      sequenceIndex: event.sequenceIndex,
      type: event.type,
    });
    if (!result.ok) {
      this.log.warn({ event, reason: result.reason }, 'confirmStop rejected via WS request');
    }
  }

  /**
   * Confirm one stop of a claimed pool. One transaction holding the pool row
   * lock (contract §1.3): ownership is checked against the committed claim,
   * the stop is stamped, the first pickup moves the pool to `closed_started`,
   * and the final stop completes the pool AND releases the driver's assignment
   * guard in the same commit (F06). A repeated confirmation returns the
   * authoritative current state instead of an error (T32). Realtime echoes and
   * the projection clear happen after commit.
   */
  async confirmStop(input: StopConfirmInput): Promise<StopConfirmResult> {
    const outcome = await this.db.transaction(async (tx): Promise<ConfirmOutcome> => {
      const pool = await this.assignments.lockSharedTrip(tx, input.rideId);
      if (!pool) return { result: { ok: false, reason: 'not_found' }, completedAt: null };
      if (pool.claimedByDriverId !== input.driverId) {
        return { result: { ok: false, reason: 'not_owner' }, completedAt: null };
      }

      const stops = await this.stops.findByRideId(input.rideId, tx);
      const target = stops.find((s) => s.sequenceIndex === input.sequenceIndex);
      if (!target) return { result: { ok: false, reason: 'not_found' }, completedAt: null };
      if (target.type !== input.type) {
        return { result: { ok: false, reason: 'wrong_type' }, completedAt: null };
      }
      const pending = stops.filter((s) => s.confirmedAt === null).length;
      if (target.confirmedAt !== null) {
        return {
          result: {
            ok: true,
            stop: target,
            pendingAfter: pending,
            rideCompleted: pool.poolState === 'completed',
            duplicate: true,
          },
          completedAt: null,
        };
      }

      const firstPending = stops.find((s) => s.confirmedAt === null);
      if (!firstPending || firstPending.sequenceIndex !== input.sequenceIndex) {
        return { result: { ok: false, reason: 'out_of_order' }, completedAt: null };
      }

      const updated = await this.stops.confirm(input.rideId, input.sequenceIndex, tx);
      if (!updated) throw new Error('confirmStop: stop changed under the pool lock');

      let poolStateChanged = false;
      if (input.type === 'pickup' && stops.every((s) => s.confirmedAt === null)) {
        await this.stops.markRideStarted(input.rideId, tx);
        poolStateChanged = true;
      }

      const pendingAfter = pending - 1;
      let completedAt: Date | null = null;
      if (pendingAfter === 0) {
        completedAt = await this.stops.markRideCompleted(input.rideId, tx);
        if (!completedAt) throw new Error('confirmStop: claimed pool could not be completed');
        poolStateChanged = true;
        await this.assignments.release(tx, {
          driverId: input.driverId,
          trip: { kind: 'shared', sharedRideId: input.rideId },
        });
      }
      return {
        result: {
          ok: true,
          stop: updated,
          pendingAfter,
          rideCompleted: pendingAfter === 0,
          duplicate: false,
        },
        completedAt,
        poolStateChanged,
      };
    });

    const { result } = outcome;
    if (!result.ok) return result;

    // ── after commit ──
    if (outcome.poolStateChanged) {
      // The `pool:<id>` hash is a projection of the committed row (F09).
      try {
        await this.poolProjection.project(input.rideId);
      } catch (err) {
        this.log.warn({ err, poolId: input.rideId }, 'pool projection failed; rebuild will repair');
      }
    }
    if (outcome.completedAt) {
      try {
        await clearCurrentRide(this.redis, input.driverId, input.rideId);
      } catch (err) {
        this.log.warn({ err, driverId: input.driverId }, 'failed to clear current_ride_id');
      }
      this.safely(() =>
        this.bus.toRide(input.rideId, RIDE_COMPLETED_EVENT, {
          rideId: input.rideId,
          completedAt: (outcome.completedAt as Date).toISOString(),
        }),
      );
    }

    const echoEvent = input.type === 'pickup' ? STOP_PICKUP_EVENT : STOP_DROP_EVENT;
    this.safely(() =>
      this.bus.toDriver(input.driverId, echoEvent, {
        rideId: input.rideId,
        sequenceIndex: input.sequenceIndex,
        passengerId: result.stop.passengerId,
        type: result.stop.type,
        confirmedAt: (result.stop.confirmedAt ?? new Date()).toISOString(),
        rideCompleted: result.rideCompleted,
      }),
    );

    return result;
  }

  private safely(deliver: () => void): void {
    try {
      deliver();
    } catch (err) {
      this.log.warn({ err }, 'post-commit delivery failed');
    }
  }
}
