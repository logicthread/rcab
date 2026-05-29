import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { SharedRideRepository } from '../matching/shared-ride.repository';
import { RideStopRepository, type RideStopRow } from '../matching/ride-stop.repository';
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
  | { ok: true; stop: RideStopRow; pendingAfter: number; rideCompleted: boolean }
  | {
      ok: false;
      reason: 'not_found' | 'not_owner' | 'wrong_type' | 'out_of_order' | 'already_confirmed';
    };

@Injectable()
export class RideLifecycleService {
  private readonly log = new Logger(RideLifecycleService.name);

  constructor(
    private readonly shared: SharedRideRepository,
    private readonly stops: RideStopRepository,
    private readonly bus: RealtimeBus,
    @Inject(REDIS) private readonly redis: Redis,
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

  async confirmStop(input: StopConfirmInput): Promise<StopConfirmResult> {
    const ride = await this.shared.findById(input.rideId);
    if (!ride) return { ok: false, reason: 'not_found' };
    if (ride.claimedByDriverId !== input.driverId) {
      this.log.warn(
        { rideId: input.rideId, driverId: input.driverId, claimed: ride.claimedByDriverId },
        'confirmStop: driver is not the claimed driver',
      );
      return { ok: false, reason: 'not_owner' };
    }

    const stops = await this.stops.findByRideId(input.rideId);
    const target = stops.find((s) => s.sequenceIndex === input.sequenceIndex);
    if (!target) return { ok: false, reason: 'not_found' };
    if (target.type !== input.type) return { ok: false, reason: 'wrong_type' };
    if (target.confirmedAt !== null) return { ok: false, reason: 'already_confirmed' };

    const firstPending = stops.find((s) => s.confirmedAt === null);
    if (!firstPending || firstPending.sequenceIndex !== input.sequenceIndex) {
      return { ok: false, reason: 'out_of_order' };
    }

    const confirmedAt = new Date();
    const updated = await this.stops.confirm(input.rideId, input.sequenceIndex, confirmedAt);
    if (!updated) return { ok: false, reason: 'already_confirmed' };

    const wasFirstConfirm = stops.every((s) => s.confirmedAt === null);
    if (wasFirstConfirm && input.type === 'pickup') {
      await this.stops.markRideStarted(input.rideId);
    }

    const pendingAfter = await this.stops.countPending(input.rideId);
    let rideCompleted = false;
    if (pendingAfter === 0) {
      await this.stops.markRideCompleted(input.rideId, confirmedAt);
      await this.clearDriverCurrentRide(input.driverId);
      rideCompleted = true;
      this.bus.toRide(input.rideId, RIDE_COMPLETED_EVENT, {
        rideId: input.rideId,
        completedAt: confirmedAt.toISOString(),
      });
    }

    const echoEvent = input.type === 'pickup' ? STOP_PICKUP_EVENT : STOP_DROP_EVENT;
    const echoPayload = {
      rideId: input.rideId,
      sequenceIndex: input.sequenceIndex,
      passengerId: updated.passengerId,
      type: updated.type,
      confirmedAt: confirmedAt.toISOString(),
      rideCompleted,
    };
    this.bus.toDriver(input.driverId, echoEvent, echoPayload);

    return { ok: true, stop: updated, pendingAfter, rideCompleted };
  }

  private async clearDriverCurrentRide(driverId: string): Promise<void> {
    try {
      await this.redis.hdel(`driver:state:${driverId}`, 'current_ride_id');
    } catch (err) {
      this.log.warn({ err, driverId }, 'failed to clear driver:state.current_ride_id');
    }
  }
}
