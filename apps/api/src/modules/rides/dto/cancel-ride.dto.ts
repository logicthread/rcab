import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of `POST /v1/rides/:id/cancel`. A plain cancel carries an optional
 * `reason` (required for a driver-initiated cancel — enforced in the
 * controller). A driver no-show is signalled by `event: 'mark_no_show'`. */
export class CancelRideDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsIn(['mark_no_show'])
  event?: 'mark_no_show';
}
