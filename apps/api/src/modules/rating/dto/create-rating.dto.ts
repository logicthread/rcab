import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Body of `POST /v1/rides/:id/ratings`. Stars are 1..5 (out-of-range → 400 via
 * the global ValidationPipe); the direction (who is rated) is inferred from the
 * caller's auth, not the body. RCAB-E4.S9.
 */
export class CreateRatingDto {
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;
}
