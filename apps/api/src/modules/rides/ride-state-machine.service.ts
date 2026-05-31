import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { RealtimeBus } from '../realtime/realtime.bus';
import { RidesRepository, type RideCancelResult, type RideRow } from './rides.repository';

export const RIDE_STATE_CHANGED_EVENT = 'ride_state_changed';

/**
 * Emitted after a solo ride is cancelled / marked no-show, so `DispatchService`
 * can unwind any in-flight dispatch (release the claim, revoke offers, drop the
 * wave / hard-fail timers). Decouples the rides module from dispatch internals
 * (mirrors the E4.S7 gateway→listener pattern). RCAB-E4.S8.
 */
export const RIDE_CANCELLED_EVENT = 'ride.cancelled';

export interface RideCancelledEventPayload {
  rideId: string;
  driverId: string | null;
}

/** The forward solo lifecycle events this story owns. Cancellation / no-show
 * events are RCAB-E4.S8 and are intentionally absent. */
export const RIDE_FORWARD_EVENTS = [
  'start_en_route',
  'mark_arrived',
  'start_ride',
  'end_ride',
] as const;
export type RideEvent = (typeof RIDE_FORWARD_EVENTS)[number];

interface TransitionSpec {
  from: string;
  to: string;
}

// The solo ride forward state machine (see [[sm-ride-lifecycle]]). DB status
// values are `en_route` / `arrived` as shipped in migration 0006 (the
// `_pickup` suffix in the note is a shared multi-stop concept).
const TRANSITIONS: Record<RideEvent, TransitionSpec> = {
  start_en_route: { from: 'accepted', to: 'en_route' },
  mark_arrived: { from: 'en_route', to: 'arrived' },
  start_ride: { from: 'arrived', to: 'in_progress' },
  end_ride: { from: 'in_progress', to: 'completed' },
};

export type RideApplyResult =
  | { ok: true; row: RideRow }
  | { ok: false; reason: 'not_found' | 'not_owner' | 'invalid_transition' | 'unknown_event' };

/**
 * The only sanctioned way to advance a solo ride's state. Validates the event,
 * delegates the guarded `SELECT … FOR UPDATE` transition to the repository,
 * then — strictly after commit — broadcasts `ride_state_changed` to the ride
 * room and clears the driver's `current_ride_id` once the ride completes.
 * RCAB-E4.S6.
 */
@Injectable()
export class RideStateMachine {
  private readonly log = new Logger(RideStateMachine.name);
  private readonly noShowWaitMs: number;

  constructor(
    private readonly repo: RidesRepository,
    private readonly bus: RealtimeBus,
    private readonly events: EventEmitter2,
    @Inject(ConfigService) config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.noShowWaitMs = config.get<number>('RIDE_NO_SHOW_WAIT_MS') ?? 300_000;
  }

  async apply(rideId: string, driverId: string, event: string): Promise<RideApplyResult> {
    const spec = TRANSITIONS[event as RideEvent];
    if (!spec) return { ok: false, reason: 'unknown_event' };

    const result = await this.repo.transition(rideId, driverId, spec.from, spec.to);
    if (!result.ok) return result;

    // Emit domain events to RealtimeBus *after* commit, never before
    // ([[module-rides]] concurrency rule).
    this.bus.toRide(rideId, RIDE_STATE_CHANGED_EVENT, {
      rideId,
      state: result.row.status,
      by: 'driver',
    });
    if (result.row.status === 'completed') {
      await this.clearDriverCurrentRide(driverId);
    }
    return result;
  }

  /**
   * Cancel a solo ride, or mark it `no_show`. The role-aware counterpart to the
   * driver-only forward `apply()`: the repository validates ownership + that the
   * current state is cancellable for the actor (and, for a no-show, that the
   * 5-minute wait has elapsed). Strictly after commit it broadcasts the terminal
   * `ride_state_changed`, frees the bound driver, and emits `RIDE_CANCELLED_EVENT`
   * so dispatch unwinds anything in flight. No fee is charged (Phase-0). RCAB-E4.S8.
   */
  async cancel(params: {
    rideId: string;
    actor: 'client' | 'driver';
    actorId: string;
    isNoShow: boolean;
    reason: string | null;
  }): Promise<RideCancelResult> {
    const result = await this.repo.cancel({ ...params, noShowWaitMs: this.noShowWaitMs });
    if (!result.ok) return result;

    // After commit only ([[module-rides]] concurrency rule): tell the ride room,
    // free the driver, and let dispatch release any in-flight artefacts.
    this.bus.toRide(params.rideId, RIDE_STATE_CHANGED_EVENT, {
      rideId: params.rideId,
      state: result.row.status,
      by: params.actor,
    });
    if (result.row.driverId) {
      await this.clearDriverCurrentRide(result.row.driverId);
    }
    this.events.emit(RIDE_CANCELLED_EVENT, {
      rideId: params.rideId,
      driverId: result.row.driverId,
    } satisfies RideCancelledEventPayload);

    return result;
  }

  private async clearDriverCurrentRide(driverId: string): Promise<void> {
    try {
      await this.redis.hdel(`driver:state:${driverId}`, 'current_ride_id');
    } catch (err) {
      this.log.warn({ err, driverId }, 'failed to clear driver:state.current_ride_id');
    }
  }
}
