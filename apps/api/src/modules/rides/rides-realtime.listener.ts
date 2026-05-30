import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RidesRepository } from './rides.repository';
import { RideStateMachine } from './ride-state-machine.service';
import { RealtimeBus } from '../realtime/realtime.bus';
import {
  DRIVER_FIRST_LOCATION_EVENT,
  RIDE_SUBSCRIBE_REQUEST_EVENT,
  type DriverFirstLocationEvent,
  type RideSubscribeRequestEvent,
} from '../realtime/realtime.gateway';

/**
 * Reacts to realtime-gateway domain events that belong to the rides domain,
 * keeping the gateway free of a `RidesRepository` dependency (RCAB-E4.S7):
 *
 * - the driver's first post-accept location packet kicks the implicit
 *   `start_en_route` (the [[sm-ride-lifecycle]] trigger E4.S6 deferred here);
 * - a client `ride:subscribe` is validated against the ride's parties, then the
 *   socket is joined to `ride:<id>` so it follows the live ride.
 */
@Injectable()
export class RidesRealtimeListener {
  private readonly log = new Logger(RidesRealtimeListener.name);

  constructor(
    private readonly stateMachine: RideStateMachine,
    private readonly ridesRepo: RidesRepository,
    private readonly bus: RealtimeBus,
  ) {}

  @OnEvent(DRIVER_FIRST_LOCATION_EVENT, { async: true })
  async onDriverFirstLocation(event: DriverFirstLocationEvent): Promise<void> {
    const result = await this.stateMachine.apply(event.rideId, event.driverId, 'start_en_route');
    if (!result.ok) {
      // Expected when the ride already moved past `accepted` (the driver may
      // have tapped Start trip first, or a stale packet arrived) — the implicit
      // transition is a harmless no-op, never an error.
      this.log.debug(
        { rideId: event.rideId, reason: result.reason },
        'implicit start_en_route skipped',
      );
    }
  }

  @OnEvent(RIDE_SUBSCRIBE_REQUEST_EVENT, { async: true })
  async onRideSubscribe(event: RideSubscribeRequestEvent): Promise<void> {
    const ride = await this.ridesRepo.findById(event.rideId);
    if (!ride) return;
    const isParty = ride.passengerId === event.userId || ride.driverId === event.userId;
    if (!isParty) {
      this.log.warn(
        { rideId: event.rideId, userId: event.userId },
        'ride:subscribe denied — caller is not a party to this ride',
      );
      return;
    }
    await this.bus.joinRide(event.userId, event.rideId);
  }
}
