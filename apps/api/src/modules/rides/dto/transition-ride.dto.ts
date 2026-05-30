import { IsIn } from 'class-validator';
import { RIDE_FORWARD_EVENTS, type RideEvent } from '../ride-state-machine.service';

/** Body of `POST /v1/rides/:id/state`. Only the four forward lifecycle events
 * are accepted; anything else is a 400 before the state machine runs. */
export class TransitionRideDto {
  @IsIn([...RIDE_FORWARD_EVENTS])
  event!: RideEvent;
}
