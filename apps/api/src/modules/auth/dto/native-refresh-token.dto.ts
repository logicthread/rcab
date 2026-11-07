import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

/** Native (mobile) clients send the refresh token in the body; there is no cookie fallback. */
export class NativeRefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  refresh_token!: string;
}
