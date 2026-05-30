import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { RealtimeBus } from '../realtime/realtime.bus';
import { RidesRepository, type RideRow } from './rides.repository';

export const RIDE_STATE_CHANGED_EVENT = 'ride_state_changed';

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

  constructor(
    private readonly repo: RidesRepository,
    private readonly bus: RealtimeBus,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

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

  private async clearDriverCurrentRide(driverId: string): Promise<void> {
    try {
      await this.redis.hdel(`driver:state:${driverId}`, 'current_ride_id');
    } catch (err) {
      this.log.warn({ err, driverId }, 'failed to clear driver:state.current_ride_id');
    }
  }
}
