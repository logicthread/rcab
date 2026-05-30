import { IsEnum, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString } from 'class-validator';

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
}
