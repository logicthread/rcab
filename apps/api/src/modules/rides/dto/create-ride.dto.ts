import {
  IsEnum,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export enum RideType {
  Normal = 'normal',
  Shared = 'shared',
  Scheduled = 'scheduled',
}

export class CreateRideDto {
  @IsEnum(RideType)
  type!: RideType;

  @IsNumber()
  @IsLatitude()
  originLat!: number;

  @IsNumber()
  @IsLongitude()
  originLng!: number;

  @IsNumber()
  @IsLatitude()
  destLat!: number;

  @IsNumber()
  @IsLongitude()
  destLng!: number;

  // Required for type=normal (RCAB-E4.S2): the signed quote token that locks
  // the fare + route. Not used by the shared path.
  @IsOptional()
  @IsString()
  quoteToken?: string;

  // Required for type=scheduled (RCAB-E6.S2): ISO-8601 pickup time. Must fall in
  // the 15 min – 24 h window (enforced in the controller). Ignored otherwise.
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;
}
