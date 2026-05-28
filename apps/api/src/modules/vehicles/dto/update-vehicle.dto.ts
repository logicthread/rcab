import { IsEnum, IsString, IsNotEmpty, IsInt, Min, IsOptional } from 'class-validator';
import { VehicleType } from './create-vehicle.dto';

export class UpdateVehicleDto {
  @IsOptional()
  @IsEnum(VehicleType)
  type?: VehicleType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reg_no?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  make?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  model?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number;
}
