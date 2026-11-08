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
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard, type JwtPayload } from '../../common/guards/auth.guard';
import { MatchingService, type SeatMatch } from '../matching/matching.service';
import type { PoolStatus } from '../matching/pool-lifecycle.service';
import { SharedRideRepository } from '../matching/shared-ride.repository';
import { RideStopRepository } from '../matching/ride-stop.repository';
import { RouteSimilarityService, type RouteGeometry } from '../matching/route-similarity.service';
import { PricingService } from '../pricing/pricing.service';
import type { Money } from '../pricing/money';
import { SHARED_FARE_POLICY, type SharedFarePolicy } from '../pricing/shared-fare-policy';
import { CreateRideDto, RideType } from './dto/create-ride.dto';
import { QuoteRideDto } from './dto/quote-ride.dto';
import { TransitionRideDto } from './dto/transition-ride.dto';
import { CancelRideDto } from './dto/cancel-ride.dto';
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
import type { IdempotencyScope } from './idempotency.repository';
import { RideStateMachine } from './ride-state-machine.service';
import { RealtimeBus } from '../realtime/realtime.bus';
import { OutboxRelay } from '../outbox/outbox.relay';
import { ScheduledDispatchService } from '../scheduled/scheduled.service';
import { getPolicy } from '../../config/policy/policy';

/** "15 minutes" / "24 hours" — whole hours when exact, else minutes. */
function formatLead(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  return unit(Math.round(ms / 60_000), 'minute');
}

// Scheduled bookings must fall in the policy window (scheduled.minLeadMs –
// scheduled.maxLeadMs: 15 min – 24 h, RCAB-E6.S2 / [[features-scheduled-booking]]).
const SCHEDULED_MIN_LEAD_MS = getPolicy().scheduled.minLeadMs;
const SCHEDULED_MAX_LEAD_MS = getPolicy().scheduled.maxLeadMs;

export interface CreateRideResponse {
  sharedRideId: string;
  passengerId: string;
  mode: SeatMatch['mode'];
  poolStatus: PoolStatus;
  /**
   * The per-seat fare this passenger agreed to, fixed at join (Phase-0
   * stand-in policy, SHARED_FARE_POLICY). Always present on a successful seat.
   */
  perSeatPrice: Money;
  farePolicy: SharedFarePolicy;
  /** Quote breakdown; absent when replaying a legacy seat or a seat re-read from the DB. */
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

/** Seat count a shared quote assumes before matching (policy pricing.sharedQuoteSeats). */
const SHARED_QUOTE_SEATS = getPolicy().pricing.sharedQuoteSeats;

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
    private readonly relay: OutboxRelay,
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
   * seat is allocated, so a concurrent duplicate gets 409
   * `idempotency_request_in_progress` rather than racing the allocation.
   *
   * Since Stage C (R08) the claim is COMPLETED in the same transaction that
   * inserts the seat (`pool_member.idempotency_key` = the key), so a committed
   * seat always has its replayable response and a retried identical request
   * replays it. A `pending` claim older than `PENDING_RECLAIM_AFTER_MS` is
   * reclaimed by a same-fingerprint retry, which looks the seat up by its exact
   * key (no passenger + time heuristic). A passenger already holding a seat in
   * another live pool under a different (or no) key gets 409
   * `passenger_has_active_pool`.
   *
   * The header is optional here only because the web client does not send it
   * for shared yet; without it a duplicate is still prevented by the one-active-
   * pool constraint, and a keyless duplicate in the same pool gets that seat back.
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

    try {
      // A reclaimed claim means a previous attempt died (or is still running
      // past the bound): if its seat committed, that seat is the answer.
      const held =
        claim.kind === 'reclaimed' ? await this.existingSharedSeat(passengerId, scope) : null;
      return held ?? (await this.allocateSharedSeat(passengerId, dto, scope));
    } catch (err) {
      // Nothing committed under this key (seat + completion are one commit):
      // free the key so the client's retry can proceed. A no-op if the claim
      // was completed (release only deletes `pending`).
      await this.idempotency
        .release(scope)
        .catch((releaseErr: unknown) =>
          this.log.error({ err: releaseErr, key }, 'idempotency release failed'),
        );
      throw err;
    }
  }

  /**
   * Records the replayable result OUTSIDE the seat transaction — only for a
   * seat that was not produced by this attempt (a legacy pre-Stage-C seat found
   * on reclaim). Retried briefly; a failure leaves the claim `pending` for the
   * next reclaim, which finds the same seat by its key.
   */
  private async completeClaim(
    scope: IdempotencyScope,
    response: CreateRideResponse,
  ): Promise<void> {
    const backoffMs = [0, 50, 200];
    let lastErr: unknown;
    for (const wait of backoffMs) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        await this.idempotency.complete(scope, response.sharedRideId, response);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    this.log.error(
      { err: lastErr, key: scope.key, sharedRideId: response.sharedRideId },
      'idempotency complete failed; claim left pending for reclaim',
    );
  }

  /**
   * The seat this key already produced, if any: the completed record's own
   * response when it exists (exact replay), else one rebuilt from the seat row
   * (its stored quote) and recorded.
   */
  private async existingSharedSeat(
    passengerId: string,
    scope: IdempotencyScope,
  ): Promise<CreateRideResponse | null> {
    const record = await this.idempotency.find(scope);
    if (record?.state === 'completed' && record.response) {
      return record.response as CreateRideResponse;
    }
    const seat = await this.matching.findSeatByIdempotencyKey(passengerId, scope.key);
    if (!seat) return null;
    const response = seatResponse(passengerId, seat);
    await this.completeClaim(scope, response);
    return response;
  }

  /**
   * Quote (OSRM, outside any transaction) → seat in one transaction that also
   * completes the idempotency claim when a scope is given.
   */
  private async allocateSharedSeat(
    passengerId: string,
    dto: CreateRideDto,
    scope?: IdempotencyScope,
  ): Promise<CreateRideResponse> {
    const toResponse = (m: SeatMatch): CreateRideResponse => ({
      sharedRideId: m.sharedRideId,
      passengerId,
      mode: m.mode,
      poolStatus: m.poolStatus,
      perSeatPrice: m.quote.perSeatPrice,
      farePolicy: m.quote.policy,
      seatMultiplier: m.quote.seatMultiplier,
      detourFactor: m.quote.detourFactor,
    });

    const result = await this.matching.findOrCreatePool(
      {
        passengerId,
        originLat: dto.originLat,
        originLng: dto.originLng,
        destLat: dto.destLat,
        destLng: dto.destLng,
      },
      {
        // Priced inside the seat transaction from the locked pool state; a
        // routing failure fails the booking (503), never a seat without a fare.
        quote: (ctx) => this.pricing.quoteSeatInItinerary(ctx),
        idempotency: scope ? { scope, response: toResponse } : undefined,
      },
    );

    switch (result.mode) {
      case 'opened':
      case 'slotted':
        return toResponse(result);
      case 'existing': {
        if (scope && result.reason === 'idempotent_replay') {
          const replay = await this.existingSharedSeat(passengerId, scope);
          if (replay) return replay;
        }
        const seat = await this.matching.findSeat(result.sharedRideId, passengerId);
        if (seat) return seatResponse(passengerId, seat);
        throw new ConflictException({
          code: 'pool_conflict',
          message: 'The shared booking changed concurrently; retry the request',
        });
      }
      case 'conflict':
        if (result.reason === 'passenger_has_active_pool') {
          throw new ConflictException({
            code: 'passenger_has_active_pool',
            message: 'You already hold a seat in an active shared ride',
            sharedRideId: result.existingPoolId ?? null,
          });
        }
        throw new ConflictException({
          code: 'pool_conflict',
          message: 'The shared booking changed concurrently; retry the request',
        });
    }
  }

  /**
   * Solo (normal) booking request. Idempotent: an `Idempotency-Key` header is
   * required, scoped to (passenger, `ride.create.solo`, key) and bound to the
   * request's fingerprint (F07). A replay returns the caller's own ride; a
   * mismatched intent is 422. The fare is locked from the signed quote token
   * (rejected if expired/tampered) — but only for a NEW booking: a replay of an
   * accepted one is returned even after its quote has expired. Persists
   * `requested` together with its dispatch work intent in ONE transaction (the
   * outbox row, R07/F08); the relay publishes it, so no in-memory event can be
   * lost between the commit and the dispatch.
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

    // The dispatch intent already committed with the ride (outbox row), so a
    // replay needs nothing here and a crash after this point loses no work.
    // The kick only shortens the latency; the relay's poll is the backstop.
    if (created) {
      // Join the booking client to the ride room so it receives
      // `ride_state_changed` once a driver starts advancing the ride (E4.S6).
      this.relay.kick();
      await this.bus.joinRide(passengerId, row.id);
    }

    return soloResponse(row);
  }

  /**
   * Scheduled (future) booking request. Same idempotent + quote-locked flow as
   * `createNormal` (scope `ride.create.scheduled`), but the ride is persisted
   * `type='scheduled'` with a future `scheduled_for` (15 min – 24 h out) and a
   * wake intent (outbox row, published as a delayed BullMQ job ~10 min before
   * pickup, RCAB-E6.S1) INSTEAD of dispatching now. The wake worker
   * (RCAB-E6.S3) runs the normal dispatch path when it fires. A replay is
   * resolved BEFORE the window check, so a late
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
        message: `scheduledFor must be between ${formatLead(SCHEDULED_MIN_LEAD_MS)} and ${formatLead(SCHEDULED_MAX_LEAD_MS)} from now`,
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

    // The wake intent committed with the ride (outbox row, R07/F08): the relay
    // publishes the delayed job, the reconciler rebuilds it if Redis loses it.
    // A replay needs nothing, and no failure here can strand the booking.
    if (created) {
      this.relay.kick();
      await this.bus.joinRide(passengerId, row.id);
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
    // has already woken (the job is gone). Best effort only: the wake worker's
    // guarded UPDATE on status='requested' is the real protection, so a late
    // or already-running wake can't dispatch a cancelled ride (T26).
    if (result.row.type === 'scheduled') {
      await this.scheduled.cancelWake(rideId).catch((err: unknown) =>
        this.log.warn({ err, rideId }, 'scheduled wake removal failed; worker status guard applies'),
      );
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
}

/** Response for a seat that already exists (built from its committed row + stored quote). */
function seatResponse(
  passengerId: string,
  seat: { poolId: string; poolState: string; opened: boolean; agreedFareCents: number | null },
): CreateRideResponse {
  if (seat.agreedFareCents === null) {
    // Only a pre-0017 seat can lack an agreed fare; never answer success
    // without a price.
    throw new InternalServerErrorException({
      code: 'fare_unavailable',
      message: 'This shared booking has no recorded fare',
      sharedRideId: seat.poolId,
    });
  }
  return {
    sharedRideId: seat.poolId,
    passengerId,
    mode: seat.opened ? 'opened' : 'slotted',
    poolStatus: seat.poolState as PoolStatus,
    perSeatPrice: { amount: seat.agreedFareCents, currency: 'INR' },
    farePolicy: SHARED_FARE_POLICY,
  };
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
