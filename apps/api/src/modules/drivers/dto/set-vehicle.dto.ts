import { IsUUID } from 'class-validator';

export class SetVehicleDto {
  @IsUUID()
  vehicle_id!: string;
}
