import { IsLatitude, IsLongitude, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

/** Query string of GET /v1/rides/snap — numbers arrive as strings, hence @Type. */
export class SnapQueryDto {
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  lng!: number;
}
