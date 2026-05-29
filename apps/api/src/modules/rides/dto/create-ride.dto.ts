import { IsEnum, IsLatitude, IsLongitude, IsNumber } from 'class-validator';

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
}
