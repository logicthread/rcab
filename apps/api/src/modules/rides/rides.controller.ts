import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  NotImplementedException,
  NotFoundException,
  Logger,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import { MatchingService, type MatchResult } from '../matching/matching.service';
import { SharedRideRepository } from '../matching/shared-ride.repository';
import { RideStopRepository } from '../matching/ride-stop.repository';
import { RouteSimilarityService, type RouteGeometry } from '../matching/route-similarity.service';
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
  geometry: RouteGeometry;
  sharedEstimate?: {
    perSeatPrice: Money;
    seatMultiplier: number;
    detourFactor: number;
    seatCount: number;
  };
}

export interface RideStopsResponse {
  rideId: string;
  poolStatus: string;
  stops: Array<{
    sequenceIndex: number;
    passengerId: string;
    type: 'pickup' | 'dropoff';
    lat: number;
    lng: number;
    confirmed: boolean;
    confirmedAt: string | null;
  }>;
}

const SHARED_QUOTE_SEATS = 2;

@Controller('v1/rides')
@UseGuards(AuthGuard)
export class RidesController {
  private readonly log = new Logger(RidesController.name);

  constructor(
    private readonly matching: MatchingService,
    private readonly pricing: PricingService,
    private readonly repo: SharedRideRepository,
    private readonly stops: RideStopRepository,
    private readonly routeSim: RouteSimilarityService,
  ) {}

  @Post('quote')
  async quote(
    @Req() req: Request & { user: JwtPayload },
    @Body() dto: QuoteRideDto,
  ): Promise<QuoteResponse> {
    this.assertClient(req.user);
    if (dto.type === RideType.Scheduled) {
      throw new NotImplementedException({
        code: 'not_implemented',
        message: `type='${dto.type}' is not implemented in Phase-0 yet (see RCAB-E6)`,
      });
    }

    const route = {
      originLat: dto.originLat,
      originLng: dto.originLng,
      destLat: dto.destLat,
      destLng: dto.destLng,
    };
    const [solo, geometry] = await Promise.all([
      this.pricing.quoteSolo(route),
      this.routeSim.getRouteGeometry(route),
    ]);

    const response: QuoteResponse = {
      type: dto.type,
      distanceM: solo.distanceM,
      durationS: solo.durationS,
      soloFare: solo.fare,
      geometry,
    };

    if (dto.type === RideType.Shared) {
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
  async create(
    @Req() req: Request & { user: JwtPayload },
    @Body() dto: CreateRideDto,
  ): Promise<CreateRideResponse> {
    this.assertClient(req.user);
    if (dto.type !== RideType.Shared) {
      throw new NotImplementedException({
        code: 'not_implemented',
        message: `type='${dto.type}' is not implemented in Phase-0 yet (see RCAB-E4.S2)`,
      });
    }

    const passengerId = req.user.sub;

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

  @Get(':id/stops')
  async listStops(
    @Req() req: Request & { user: JwtPayload },
    @Param('id') rideId: string,
  ): Promise<RideStopsResponse> {
    const ride = await this.repo.findById(rideId);
    if (!ride) {
      throw new NotFoundException({ code: 'ride_not_found', message: 'ride not found' });
    }
    if (req.user.role !== 'driver' || ride.claimedByDriverId !== req.user.sub) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: "only the claimed driver can read this ride's stops",
      });
    }
    const rows = await this.stops.findByRideId(rideId);
    return {
      rideId,
      poolStatus: ride.poolState,
      stops: rows.map((r) => ({
        sequenceIndex: r.sequenceIndex,
        passengerId: r.passengerId,
        type: r.type,
        lat: r.lat,
        lng: r.lng,
        confirmed: r.confirmedAt !== null,
        confirmedAt: r.confirmedAt?.toISOString() ?? null,
      })),
    };
  }

  private assertClient(user: JwtPayload): void {
    if (user.role !== 'client') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Client role required',
      });
    }
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
      this.log.warn({ err, sharedRideId: result.sharedRideId }, 'seat pricing failed');
      return null;
    }
  }
}
