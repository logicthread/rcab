import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;
}

export class SubmitFeedbackDto {
  @IsIn(['bug', 'idea', 'compliment', 'other'])
  category!: 'bug' | 'idea' | 'compliment' | 'other';

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message!: string;
}

export class SendSupportMessageDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
