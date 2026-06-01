import {
  Controller,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import { CreateRatingDto } from './dto/create-rating.dto';
import { RatingService } from './rating.service';

export interface RatingResponse {
  id: string;
  rideId: string;
  subjectId: string;
  stars: number;
}

/**
 * Two-sided rating capture. `POST /v1/rides/:id/ratings` — either party of a
 * completed solo ride rates the other (direction inferred from auth). Maps the
 * service result to HTTP: 201 (created), 403 (not a party), 404 (unknown ride),
 * 409 (`ride_not_completed` / `already_rated`). RCAB-E4.S9.
 */
@Controller('v1/rides')
@UseGuards(AuthGuard)
export class RatingController {
  constructor(private readonly rating: RatingService) {}

  @Post(':id/ratings')
  async rate(
    @Req() req: Request & { user: JwtPayload },
    @Param('id') rideId: string,
    @Body() dto: CreateRatingDto,
  ): Promise<RatingResponse> {
    const result = await this.rating.rate({
      rideId,
      raterId: req.user.sub,
      stars: dto.stars,
      text: dto.text ?? null,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          throw new NotFoundException({ code: 'ride_not_found', message: 'ride not found' });
        case 'not_a_party':
          throw new ForbiddenException({
            code: 'forbidden',
            message: 'only a party to this ride can rate it',
          });
        case 'not_completed':
          throw new ConflictException({
            code: 'ride_not_completed',
            message: 'only a completed ride can be rated',
          });
        case 'already_rated':
        default:
          throw new ConflictException({
            code: 'already_rated',
            message: 'you have already rated this ride',
          });
      }
    }
    return {
      id: result.rating.id,
      rideId: result.rating.rideId,
      subjectId: result.rating.subjectId,
      stars: result.rating.stars,
    };
  }
}
