import { IsString, IsNotEmpty } from 'class-validator';

export class GoogleIdTokenDto {
  @IsString()
  @IsNotEmpty()
  google_id_token!: string;
}
