import { Controller, Post, Body, NotImplementedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MatchingService, type MatchResult } from '../matching/matching.service';
import { CreateRideDto, RideType } from './dto/create-ride.dto';

export interface CreateRideResponse {
  sharedRideId: string;
  passengerId:  string;
  mode:         MatchResult['mode'];
  poolStatus:   MatchResult['poolStatus'];
}

@Controller('v1/rides')
export class RidesController {
  constructor(private readonly matching: MatchingService) {}

  @Post()
  async create(@Body() dto: CreateRideDto): Promise<CreateRideResponse> {
    if (dto.type !== RideType.Shared) {
      throw new NotImplementedException({
        code: 'not_implemented',
        message: `type='${dto.type}' is not implemented in Phase-0 yet (see RCAB-E4.S2)`,
      });
    }

    // TODO(RCAB-E4.S2): replace with authenticated user id once RideRequest entity lands.
    const passengerId = dto.passengerId ?? randomUUID();

    const result = await this.matching.findOrCreatePool({
      passengerId,
      originLat: dto.originLat,
      originLng: dto.originLng,
      destLat:   dto.destLat,
      destLng:   dto.destLng,
    });

    return {
      sharedRideId: result.sharedRideId,
      passengerId,
      mode:         result.mode,
      poolStatus:   result.poolStatus,
    };
  }
}
