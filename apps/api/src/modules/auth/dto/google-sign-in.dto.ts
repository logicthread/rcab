import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/** POST /v1/auth/google and /v1/auth/native/google (RCAB-E8.S15). */
export class GoogleSignInDto {
  /** A Google ID token (JWT) issued for one of GOOGLE_CLIENT_IDS. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(8192)
  id_token!: string;
}
