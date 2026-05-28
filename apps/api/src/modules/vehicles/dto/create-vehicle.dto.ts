import { IsEnum, IsString, IsNotEmpty, IsInt, Min } from 'class-validator';

export enum VehicleType {
  Auto = 'auto',
  Bike = 'bike',
  CabHatch = 'cab_hatch',
  CabSedan = 'cab_sedan',
}

export class CreateVehicleDto {
  @IsEnum(VehicleType)
  type!: VehicleType;

  @IsString()
  @IsNotEmpty()
  reg_no!: string;

  @IsString()
  @IsNotEmpty()
  make!: string;

  @IsString()
  @IsNotEmpty()
  model!: string;

  @IsString()
  @IsNotEmpty()
  color!: string;

  @IsInt()
  @Min(1)
  seats!: number;
}
