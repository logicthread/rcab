import { IsNumber } from 'class-validator';

export class GoOnlineDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;
}
