import { IsString, IsNotEmpty } from 'class-validator';

export class FirebaseExchangeDto {
  @IsString()
  @IsNotEmpty()
  id_token!: string;
}
