import { IsEnum, IsLatitude, IsLongitude, IsNumber } from 'class-validator';
import { RideType } from './create-ride.dto';

export class QuoteRideDto {
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
