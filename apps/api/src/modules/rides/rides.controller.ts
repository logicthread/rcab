import { Controller, Post, Body, NotImplementedException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MatchingService, type MatchResult } from '../matching/matching.service';
import { SharedRideRepository } from '../matching/shared-ride.repository';
import { PricingService } from '../pricing/pricing.service';
import type { Money } from '../pricing/money';
import type { SeatQuote } from '../pricing/pricing.types';
import { CreateRideDto, RideType } from './dto/create-ride.dto';
import { QuoteRideDto } from './dto/quote-ride.dto';

export interface CreateRideResponse {
  sharedRideId: string;
  passengerId: string;
  mode: MatchResult['mode'];
  poolStatus: MatchResult['poolStatus'];
  perSeatPrice?: Money;
  seatMultiplier?: number;
  detourFactor?: number;
}

export interface QuoteResponse {
  type: RideType;
  distanceM: number;
  durationS: number;
  soloFare: Money;
  sharedEstimate?: {
    perSeatPrice: Money;
    seatMultiplier: number;
    detourFactor: number;
    seatCount: number;
  };
}

const SHARED_QUOTE_SEATS = 2;

@Controller('v1/rides')
export class RidesController {
  private readonly log = new Logger(RidesController.name);

  constructor(
    private readonly matching: MatchingService,
    private readonly pricing: PricingService,
    private readonly repo: SharedRideRepository,
  ) {}

  @Post('quote')
  async quote(@Body() dto: QuoteRideDto): Promise<QuoteResponse> {
    if (dto.type === RideType.Scheduled) {
      throw new NotImplementedException({
        code: 'not_implemented',
        message: `type='${dto.type}' is not implemented in Phase-0 yet (see RCAB-E6)`,
      });
    }

    const solo = await this.pricing.quoteSolo({
      originLat: dto.originLat,
      originLng: dto.originLng,
      destLat: dto.destLat,
      destLng: dto.destLng,
    });

    const response: QuoteResponse = {
      type: dto.type,
      distanceM: solo.distanceM,
      durationS: solo.durationS,
      soloFare: solo.fare,
    };

    if (dto.type === RideType.Shared) {
      // Indicative shared estimate for an empty pool that this rider would open.
      // Detour factor = 1.0 by construction (no other passengers yet).
      const seatMultiplier = this.pricing.seatMultiplierFor(SHARED_QUOTE_SEATS);
      const { perSeatPrice, detourFactor } = this.pricing.quoteSeatFromMetrics({
        soloPrice: solo.fare,
        seatCount: SHARED_QUOTE_SEATS,
        directDistanceM: solo.distanceM,
        poolDistanceM: solo.distanceM,
      });
      response.sharedEstimate = {
        perSeatPrice,
        seatMultiplier,
        detourFactor,
        seatCount: SHARED_QUOTE_SEATS,
      };
    }

    return response;
  }

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
      destLat: dto.destLat,
      destLng: dto.destLng,
    });

    const seatQuote = await this.priceMatchedSeat(result, dto);

    return {
      sharedRideId: result.sharedRideId,
      passengerId,
      mode: result.mode,
      poolStatus: result.poolStatus,
      perSeatPrice: seatQuote?.perSeatPrice,
      seatMultiplier: seatQuote?.seatMultiplier,
      detourFactor: seatQuote?.detourFactor,
    };
  }

  private async priceMatchedSeat(
    result: MatchResult,
    dto: CreateRideDto,
  ): Promise<SeatQuote | null> {
    try {
      const pool = await this.repo.findById(result.sharedRideId);
      if (!pool) return null;
      return await this.pricing.quoteSeat(pool, {
        route: {
          originLat: dto.originLat,
          originLng: dto.originLng,
          destLat: dto.destLat,
          destLng: dto.destLng,
        },
      });
    } catch (err) {
      // Pricing failure must not block ride creation — return without seat fields.
      this.log.warn({ err, sharedRideId: result.sharedRideId }, 'seat pricing failed');
      return null;
    }
  }
}
