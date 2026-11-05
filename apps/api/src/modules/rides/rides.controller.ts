import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  HttpCode,
  BadRequestException,
  ConflictException,
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
import { TransitionRideDto } from './dto/transition-ride.dto';
import { CancelRideDto } from './dto/cancel-ride.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { QuoteTokenService, type QuoteClaims } from './quote-token.service';
import { RidesRepository, type RideIdempotencyOperation, type RideRow } from './rides.repository';
import { IdempotencyRepository } from './idempotency.repository';
import {
  IdempotencyOperation,
  fingerprintMatches,
  idempotencyKeyConflict,
  idempotencyRequestInProgress,
  parseIdempotencyKey,
  requestFingerprint,
} from './idempotency';
import { RideStateMachine } from './ride-state-machine.service';
import { RealtimeBus } from '../realtime/realtime.bus';
import { RIDE_REQUESTED_EVENT, type RideRequestedEventPayload } from '../dispatch/dispatch.service';
import { ScheduledDispatchService } from '../scheduled/scheduled.service';

// Scheduled bookings must fall in a 15 min – 24 h future window (RCAB-E6.S2 /
// [[features-scheduled-booking]]).
const SCHEDULED_MIN_LEAD_MS = 15 * 60 * 1000;
const SCHEDULED_MAX_LEAD_MS = 24 * 60 * 60 * 1000;

export interface CreateRideResponse {
  sharedRideId: string;
  passengerId: string;
  mode: MatchResult['mode'];
  poolStatus: MatchResult['poolStatus'];
  perSeatPrice?: Money;
  seatMultiplier?: number;
  detourFactor?: number;
}

export interface SoloRideResponse {
  rideId: string;
  passengerId: string;
  status: string;
  fare: Money;
}

export interface QuoteResponse {
  type: RideType;
  distanceM: number;
  durationS: number;
  soloFare: Money;
  geometry: RouteGeometry;
  quoteToken: string;
  sharedEstimate?: {
    perSeatPrice: Money;
    seatMultiplier: number;
    detourFactor: number;
    seatCount: number;
  };
}

export interface RideDetailResponse {
  rideId: string;
  passengerId: string;
  driverId: string | null;
  status: string;
  fare: Money;
  origin: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  cancelledBy: string | null;
  cancelReason: string | null;
  timestamps: {
    acceptedAt: string | null;
    enRouteAt: string | null;
    arrivedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
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
    private readonly quoteToken: QuoteTokenService,
    private readonly ridesRepo: RidesRepository,
    private readonly stateMachine: RideStateMachine,
    private readonly bus: RealtimeBus,
    private readonly events: EventEmitter2,
    private readonly scheduled: ScheduledDispatchService,
    private readonly idempotency: IdempotencyRepository,
  ) {}

  @Post('quote')
  async quote(
    @Req() req: Request & { user: JwtPayload },
    @Body() dto: QuoteRideDto,
  ): Promise<QuoteResponse> {
    this.assertClient(req.user);
    // A scheduled quote is priced exactly like a normal one (fare + route +
    // signed token); the future pickup time is supplied later, at request
    // (RCAB-E6.S2). So scheduled falls through the normal quote path here.

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
      quoteToken: this.quoteToken.sign({
        originLat: route.originLat,
        originLng: route.originLng,
        destLat: route.destLat,
        destLng: route.destLng,
        soloFareCents: solo.fare.amount,
        distanceM: solo.distanceM,
        durationS: solo.durationS,
      }),
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
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateRideResponse | SoloRideResponse> {
    this.assertClient(req.user);

    if (dto.type === RideType.Normal) {
      return this.createNormal(req.user.sub, dto, idempotencyKey);
    }
    if (dto.type === RideType.Scheduled) {
      return this.createScheduled(req.user.sub, dto, idempotencyKey);
    }
    if (dto.type !== RideType.Shared) {
      throw new NotImplementedException({
        code: 'not_implemented',
        message: `type='${dto.type}' is not implemented in Phase-0 yet (see RCAB-E6)`,
      });
    }
    return this.createShared(req.user.sub, dto, idempotencyKey);
  }

  /**
   * Shared (pooled) booking request. Honors `Idempotency-Key` with the same
   * account-scoped contract as solo (F15): the key is claimed durably BEFORE a
   * seat is allocated, so a retried identical request replays the original
   * result instead of taking a second seat, and a concurrent duplicate gets 409
   * `idempotency_request_in_progress` rather than racing the allocation.
   *
   * The header is optional here only because the web client does not send it
   * for shared yet; without it the request is not retry-safe (legacy).
   * TODO(R08): fold the claim/complete into the pool-membership transaction so
   * a crash between allocation and `complete` can't strand a `pending` claim.
   */
  private async createShared(
    passengerId: string,
    dto: CreateRideDto,
    rawKey: string | undefined,
  ): Promise<CreateRideResponse> {
    const key = parseIdempotencyKey(rawKey, false);
    if (!key) return this.allocateSharedSeat(passengerId, dto);

    const scope = { principalId: passengerId, operation: IdempotencyOperation.Shared, key };
    const fingerprint = requestFingerprint(IdempotencyOperation.Shared, dto);
    const claim = await this.idempotency.claim(scope, fingerprint);
    if (claim.kind === 'existing') {
      const { record } = claim;
      if (record.requestFingerprint !== fingerprint) throw idempotencyKeyConflict();
      if (record.state === 'completed' && record.response) {
        return record.response as CreateRideResponse;
      }
      throw idempotencyRequestInProgress();
    }

    let response: CreateRideResponse;
    try {
      response = await this.allocateSharedSeat(passengerId, dto);
    } catch (err) {
      // Allocation failed: free the key so the client's retry can proceed.
      await this.idempotency
        .release(scope)
        .catch((releaseErr: unknown) =>
          this.log.error({ err: releaseErr, key }, 'idempotency release failed'),
        );
      throw err;
    }
    try {
      await this.idempotency.complete(scope, response.sharedRideId, response);
    } catch (err) {
      // The seat IS allocated, so returning it is right. The claim stays
      // `pending`, so a retry gets 409 rather than a second seat.
      this.log.error(
        { err, key, sharedRideId: response.sharedRideId },
        'idempotency complete failed',
      );
    }
    return response;
  }

  private async allocateSharedSeat(
    passengerId: string,
    dto: CreateRideDto,
  ): Promise<CreateRideResponse> {
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

  /**
   * Solo (normal) booking request. Idempotent: an `Idempotency-Key` header is
   * required, scoped to (passenger, `ride.create.solo`, key) and bound to the
   * request's fingerprint (F07). A replay returns the caller's own ride; a
   * mismatched intent is 422. The fare is locked from the signed quote token
   * (rejected if expired/tampered) — but only for a NEW booking: a replay of an
   * accepted one is returned even after its quote has expired. Persists
   * `requested`; dispatch is RCAB-E4.S3.
   */
  private async createNormal(
    passengerId: string,
    dto: CreateRideDto,
    rawKey: string | undefined,
  ): Promise<SoloRideResponse> {
    const key = parseIdempotencyKey(rawKey, true);
    if (!dto.quoteToken) {
      throw new BadRequestException({ code: 'invalid_quote', message: 'quoteToken is required' });
    }
    const operation = IdempotencyOperation.Solo;
    const fingerprint = requestFingerprint(operation, dto);

    const replay = await this.replaySolo(passengerId, operation, key, fingerprint);
    if (replay) return replay;

    const claims = this.verifyQuote(dto);
    const {
      row,
      created,
      requestFingerprint: stored,
    } = await this.ridesRepo.create({
      passengerId,
      originLat: dto.originLat,
      originLng: dto.originLng,
      destLat: dto.destLat,
      destLng: dto.destLng,
      fareCents: claims.soloFareCents,
      idempotencyKey: key,
      idempotencyOperation: operation,
      requestFingerprint: fingerprint,
    });
    // Lost a concurrent first-use race to a request with a different intent.
    if (!created && !fingerprintMatches(stored, fingerprint)) throw idempotencyKeyConflict();

    // Only a freshly-created ride triggers dispatch — a replay must not re-dispatch.
    // TODO(F08/R07): if the process dies after the insert but before the emit,
    // a retry replays the row without dispatching it; Stage C's outbox owns this.
    if (created) {
      // Join the booking client to the ride room so it receives
      // `ride_state_changed` once a driver starts advancing the ride (E4.S6).
      await this.bus.joinRide(passengerId, row.id);
      this.events.emit(RIDE_REQUESTED_EVENT, {
        rideId: row.id,
      } satisfies RideRequestedEventPayload);
    }

    return soloResponse(row);
  }

  /**
   * Scheduled (future) booking request. Same idempotent + quote-locked flow as
   * `createNormal` (scope `ride.create.scheduled`), but the ride is persisted
   * `type='scheduled'` with a future `scheduled_for` (15 min – 24 h out) and a
   * BullMQ wake job is enqueued (~10 min before pickup, RCAB-E6.S1) INSTEAD of
   * dispatching now. The wake worker (RCAB-E6.S3) runs the normal dispatch path
   * when it fires. A replay is resolved BEFORE the window check, so a late
   * retry still recovers the committed booking (R05).
   */
  private async createScheduled(
    passengerId: string,
    dto: CreateRideDto,
    rawKey: string | undefined,
  ): Promise<SoloRideResponse> {
    const key = parseIdempotencyKey(rawKey, true);
    if (!dto.quoteToken) {
      throw new BadRequestException({ code: 'invalid_quote', message: 'quoteToken is required' });
    }
    if (!dto.scheduledFor) {
      throw new BadRequestException({
        code: 'scheduled_for_required',
        message: 'scheduledFor is required for a scheduled ride',
      });
    }
    const operation = IdempotencyOperation.Scheduled;
    const fingerprint = requestFingerprint(operation, dto);

    const replay = await this.replaySolo(passengerId, operation, key, fingerprint);
    if (replay) return replay;

    const scheduledFor = new Date(dto.scheduledFor);
    const leadMs = scheduledFor.getTime() - Date.now();
    if (
      Number.isNaN(scheduledFor.getTime()) ||
      leadMs < SCHEDULED_MIN_LEAD_MS ||
      leadMs > SCHEDULED_MAX_LEAD_MS
    ) {
      throw new BadRequestException({
        code: 'scheduled_for_out_of_window',
        message: 'scheduledFor must be between 15 minutes and 24 hours from now',
      });
    }

    const claims = this.verifyQuote(dto);
    const {
      row,
      created,
      requestFingerprint: stored,
    } = await this.ridesRepo.create({
      passengerId,
      originLat: dto.originLat,
      originLng: dto.originLng,
      destLat: dto.destLat,
      destLng: dto.destLng,
      fareCents: claims.soloFareCents,
      idempotencyKey: key,
      idempotencyOperation: operation,
      requestFingerprint: fingerprint,
      type: 'scheduled',
      scheduledFor,
    });
    if (!created && !fingerprintMatches(stored, fingerprint)) throw idempotencyKeyConflict();

    // A freshly-created scheduled ride enqueues a delayed wake instead of
    // dispatching now (a replay must not double-schedule).
    // TODO(F08/R07): if scheduleWake fails after the insert, a retry replays the
    // row and never re-enqueues the wake; Stage C's outbox/reconciler owns this.
    if (created) {
      await this.bus.joinRide(passengerId, row.id);
      await this.scheduled.scheduleWake(row.id, scheduledFor);
    }

    return soloResponse(row);
  }

  /**
   * Replay lookup for solo/scheduled creates, against the durable row only and
   * only within the caller's own (passenger, operation) scope — another
   * account's identical key is simply not found (F07). Same intent → the
   * original ride; different intent → 422 with no mutation.
   */
  private async replaySolo(
    passengerId: string,
    operation: RideIdempotencyOperation,
    key: string,
    fingerprint: string,
  ): Promise<SoloRideResponse | null> {
    const existing = await this.ridesRepo.findByIdempotencyScope(passengerId, operation, key);
    if (!existing) return null;
    if (!fingerprintMatches(existing.requestFingerprint, fingerprint)) {
      throw idempotencyKeyConflict();
    }
    return soloResponse(existing.row);
  }

  private verifyQuote(dto: CreateRideDto): QuoteClaims {
    let claims: QuoteClaims;
    try {
      claims = this.quoteToken.verify(dto.quoteToken ?? '');
    } catch (err) {
      const expired = err instanceof Error && err.name === 'TokenExpiredError';
      throw new BadRequestException({
        code: expired ? 'quote_expired' : 'invalid_quote',
        message: expired ? 'Quote expired — please re-quote' : 'Invalid quote token',
      });
    }
    if (!coordsMatch(claims, dto)) {
      throw new BadRequestException({
        code: 'quote_mismatch',
        message: 'Quote does not match the requested route',
      });
    }
    return claims;
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

  @Get(':id')
  async getRide(
    @Req() req: Request & { user: JwtPayload },
    @Param('id') rideId: string,
  ): Promise<RideDetailResponse> {
    const ride = await this.ridesRepo.findById(rideId);
    if (!ride) {
      throw new NotFoundException({ code: 'ride_not_found', message: 'ride not found' });
    }
    const isPassenger = req.user.role === 'client' && ride.passengerId === req.user.sub;
    const isDriver = req.user.role === 'driver' && ride.driverId === req.user.sub;
    if (!isPassenger && !isDriver) {
      throw new ForbiddenException({ code: 'forbidden', message: 'not your ride' });
    }
    return rideDetail(ride);
  }

  /**
   * Advance a solo ride through the [[sm-ride-lifecycle]] forward state machine.
   * Driver-only; only the bound driver may transition. Maps the state-machine
   * result to HTTP: 200 (advanced), 400 (unknown event — guarded by the DTO),
   * 403 (not the bound driver), 404 (unknown ride), 409 (out-of-order). E4.S6.
   */
  @Post(':id/state')
  @HttpCode(200)
  async transition(
    @Req() req: Request & { user: JwtPayload },
    @Param('id') rideId: string,
    @Body() dto: TransitionRideDto,
  ): Promise<{ rideId: string; status: string }> {
    this.assertDriver(req.user);
    const result = await this.stateMachine.apply(rideId, req.user.sub, dto.event);
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          throw new NotFoundException({ code: 'ride_not_found', message: 'ride not found' });
        case 'not_owner':
          throw new ForbiddenException({
            code: 'forbidden',
            message: 'only the assigned driver can advance this ride',
          });
        case 'unknown_event':
          throw new BadRequestException({
            code: 'invalid_event',
            message: `unknown lifecycle event '${dto.event}'`,
          });
        case 'invalid_transition':
        default:
          throw new ConflictException({
            code: 'invalid_transition',
            message: `cannot apply '${dto.event}' from the ride's current state`,
          });
      }
    }
    return { rideId: result.row.id, status: result.row.status };
  }

  /**
   * Cancel a solo ride, or (driver-only) report a no-show. Role-aware: a client
   * cancels their own ride before the trip starts; the bound driver may cancel
   * any time pre-completion or report a no-show once `arrived` + the 5-min wait.
   * A driver-initiated cancel requires a reason. Maps the state-machine result
   * to HTTP: 200, 403 (not your ride / non-driver no-show), 404, 409
   * (out-of-order or `no_show_too_early`). No fee in Phase-0. RCAB-E4.S8.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @Req() req: Request & { user: JwtPayload },
    @Param('id') rideId: string,
    @Body() dto: CancelRideDto,
  ): Promise<{ rideId: string; status: string; cancelledBy: string | null }> {
    const role = req.user.role;
    if (role !== 'client' && role !== 'driver') {
      throw new ForbiddenException({ code: 'forbidden', message: 'cannot cancel this ride' });
    }
    const isNoShow = dto.event === 'mark_no_show';
    if (isNoShow && role !== 'driver') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'only the driver can report a no-show',
      });
    }
    if (role === 'driver' && !isNoShow && !dto.reason) {
      throw new BadRequestException({
        code: 'reason_required',
        message: 'a driver cancellation requires a reason',
      });
    }

    const result = await this.stateMachine.cancel({
      rideId,
      actor: role,
      actorId: req.user.sub,
      isNoShow,
      reason: isNoShow ? 'no_show' : (dto.reason ?? null),
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          throw new NotFoundException({ code: 'ride_not_found', message: 'ride not found' });
        case 'not_owner':
          throw new ForbiddenException({ code: 'forbidden', message: 'not your ride' });
        case 'no_show_too_early':
          throw new ConflictException({
            code: 'no_show_too_early',
            message: 'the no-show wait has not elapsed yet',
          });
        case 'invalid_transition':
        default:
          throw new ConflictException({
            code: 'invalid_transition',
            message: "the ride's current state cannot be cancelled",
          });
      }
    }
    // A cancelled scheduled ride drops its pending wake job so it never fires
    // (free cancellation before wake — RCAB-E6.S4). Safe/no-op after the ride
    // has already woken (the job is gone), and dispatchSolo guards
    // status='requested' anyway, so a race can't dispatch a cancelled ride.
    if (result.row.type === 'scheduled') {
      await this.scheduled.cancelWake(rideId);
    }

    return {
      rideId: result.row.id,
      status: result.row.status,
      cancelledBy: result.row.cancelledBy,
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

  private assertDriver(user: JwtPayload): void {
    if (user.role !== 'driver') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Driver role required',
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

function soloResponse(row: RideRow): SoloRideResponse {
  return {
    rideId: row.id,
    passengerId: row.passengerId,
    status: row.status,
    fare: { amount: row.fareCents, currency: 'INR' },
  };
}

function rideDetail(row: RideRow): RideDetailResponse {
  return {
    rideId: row.id,
    passengerId: row.passengerId,
    driverId: row.driverId,
    status: row.status,
    fare: { amount: row.fareCents, currency: 'INR' },
    origin: { lat: row.originLat, lng: row.originLng },
    dropoff: { lat: row.destLat, lng: row.destLng },
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    timestamps: {
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      enRouteAt: row.enRouteAt?.toISOString() ?? null,
      arrivedAt: row.arrivedAt?.toISOString() ?? null,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
    },
  };
}

// The client posts identical coordinates to /quote and /rides, so the token's
// locked route must match the request — guards against quoting A→B then booking C→D.
function coordsMatch(claims: QuoteClaims, dto: CreateRideDto): boolean {
  const eps = 1e-6;
  return (
    Math.abs(claims.originLat - dto.originLat) < eps &&
    Math.abs(claims.originLng - dto.originLng) < eps &&
    Math.abs(claims.destLat - dto.destLat) < eps &&
    Math.abs(claims.destLng - dto.destLng) < eps
  );
}
