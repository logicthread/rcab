import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RidesController } from './rides.controller';
import { RideType } from './dto/create-ride.dto';
import type { RideRow } from './rides.repository';
import type { JwtPayload } from '../../common/guards/auth.guard';
import type { SharedRideRow } from '../matching/shared-ride.repository';
import type { RideStopRow } from '../matching/ride-stop.repository';

const DRIVER_ID = 'driver-1';
const RIDE_ID = 'ride-1';
const PASSENGER_ID = 'passenger-1';

function jwtDriver(): JwtPayload {
  return { sub: DRIVER_ID, role: 'driver' } as JwtPayload;
}

function ride(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId: RIDE_ID,
    seatCount: 2,
    maxSeats: 3,
    poolState: 'closed_full',
    poolClosedAt: new Date(),
    detourBudgetM: 800,
    originLat: 0,
    originLng: 0,
    destLat: 0,
    destLng: 0,
    members: [],
    claimedByDriverId: DRIVER_ID,
    claimedAt: new Date(),
    ...overrides,
  };
}

function stop(overrides: Partial<RideStopRow> = {}): RideStopRow {
  return {
    rideId: RIDE_ID,
    sequenceIndex: 0,
    passengerId: PASSENGER_ID,
    type: 'pickup',
    lat: 0,
    lng: 0,
    confirmedAt: null,
    ...overrides,
  };
}

function soloRideRow(overrides: Partial<RideRow> = {}): RideRow {
  return {
    id: 'ride-9',
    passengerId: 'c-1',
    originLat: 26.1445,
    originLng: 91.7362,
    destLat: 26.1758,
    destLng: 91.7898,
    fareCents: 18500,
    status: 'requested',
    type: 'normal',
    scheduledFor: null,
    idempotencyKey: 'idem-1',
    driverId: null,
    acceptedAt: null,
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    ...overrides,
  };
}

function makeController(
  opts: {
    ride?: SharedRideRow | null;
    stops?: RideStopRow[];
    quoteSolo?: ReturnType<typeof vi.fn>;
    getRouteGeometry?: ReturnType<typeof vi.fn>;
    verify?: ReturnType<typeof vi.fn>;
    ridesCreate?: ReturnType<typeof vi.fn>;
    ridesFindById?: ReturnType<typeof vi.fn>;
    redisGet?: ReturnType<typeof vi.fn>;
    apply?: ReturnType<typeof vi.fn>;
    cancel?: ReturnType<typeof vi.fn>;
    scheduleWake?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const matching = { findOrCreatePool: vi.fn() };
  const pricing = {
    quoteSolo: opts.quoteSolo ?? vi.fn(),
    quoteSeat: vi.fn(),
    seatMultiplierFor: vi.fn(),
    quoteSeatFromMetrics: vi.fn(),
  };
  const repo = {
    findById: vi.fn().mockResolvedValue(opts.ride === undefined ? ride() : opts.ride),
  };
  const stops = {
    findByRideId: vi.fn().mockResolvedValue(opts.stops ?? []),
  };
  const routeSim = {
    getRouteGeometry: opts.getRouteGeometry ?? vi.fn(),
  };
  const quoteToken = {
    sign: vi.fn().mockReturnValue('quote.tok'),
    verify: opts.verify ?? vi.fn(),
  };
  const ridesRepo = {
    create: opts.ridesCreate ?? vi.fn(),
    findById: opts.ridesFindById ?? vi.fn(),
  };
  const stateMachine = { apply: opts.apply ?? vi.fn(), cancel: opts.cancel ?? vi.fn() };
  const bus = { joinRide: vi.fn().mockResolvedValue(undefined) };
  const redis = {
    get: opts.redisGet ?? vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
  const events = { emit: vi.fn() };
  const scheduled = {
    scheduleWake: opts.scheduleWake ?? vi.fn().mockResolvedValue({ jobId: 'j', delayMs: 0 }),
    cancelWake: vi.fn().mockResolvedValue(true),
  };
  const ctrl = new RidesController(
    matching as never,
    pricing as never,
    repo as never,
    stops as never,
    routeSim as never,
    quoteToken as never,
    ridesRepo as never,
    stateMachine as never,
    bus as never,
    events as never,
    scheduled as never,
    redis as never,
  );
  return {
    ctrl,
    repo,
    stops,
    pricing,
    routeSim,
    quoteToken,
    ridesRepo,
    stateMachine,
    bus,
    redis,
    events,
    matching,
    scheduled,
  };
}

describe('RidesController.listStops', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when ride does not exist', async () => {
    const { ctrl } = makeController({ ride: null });
    await expect(ctrl.listStops({ user: jwtDriver() } as never, RIDE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns 403 when caller is not the claimed driver', async () => {
    const { ctrl } = makeController({ ride: ride({ claimedByDriverId: 'other-driver' }) });
    await expect(ctrl.listStops({ user: jwtDriver() } as never, RIDE_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns 403 when caller role is not driver', async () => {
    const { ctrl } = makeController();
    const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
    await expect(ctrl.listStops(clientReq as never, RIDE_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns ordered stops with confirmed flags for the claimed driver', async () => {
    const confirmedAt = new Date('2026-05-29T12:00:00.000Z');
    const { ctrl } = makeController({
      stops: [
        stop({ sequenceIndex: 0, type: 'pickup', confirmedAt }),
        stop({ sequenceIndex: 1, type: 'pickup' }),
        stop({ sequenceIndex: 2, type: 'dropoff' }),
      ],
    });
    const result = await ctrl.listStops({ user: jwtDriver() } as never, RIDE_ID);
    expect(result.rideId).toBe(RIDE_ID);
    expect(result.poolStatus).toBe('closed_full');
    expect(result.stops).toEqual([
      {
        sequenceIndex: 0,
        passengerId: PASSENGER_ID,
        type: 'pickup',
        lat: 0,
        lng: 0,
        confirmed: true,
        confirmedAt: confirmedAt.toISOString(),
      },
      {
        sequenceIndex: 1,
        passengerId: PASSENGER_ID,
        type: 'pickup',
        lat: 0,
        lng: 0,
        confirmed: false,
        confirmedAt: null,
      },
      {
        sequenceIndex: 2,
        passengerId: PASSENGER_ID,
        type: 'dropoff',
        lat: 0,
        lng: 0,
        confirmed: false,
        confirmedAt: null,
      },
    ]);
  });
});

describe('RidesController.quote', () => {
  beforeEach(() => vi.clearAllMocks());

  const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
  // NE-India (Guwahati) — within the loaded OSRM dev graph.
  const soloDto = {
    type: RideType.Normal,
    originLat: 26.1445,
    originLng: 91.7362,
    destLat: 26.1758,
    destLng: 91.7898,
  } as never;
  const GEOMETRY = {
    type: 'LineString' as const,
    coordinates: [
      [91.7362, 26.1445],
      [91.75, 26.16],
      [91.7898, 26.1758],
    ] as [number, number][],
  };
  const solo = {
    fare: { amount: 18500, currency: 'INR' as const },
    distanceM: 10197,
    durationS: 796,
  };

  it('includes the OSRM route geometry + a signed quote token alongside the fare', async () => {
    const { ctrl, quoteToken } = makeController({
      quoteSolo: vi.fn().mockResolvedValue(solo),
      getRouteGeometry: vi.fn().mockResolvedValue(GEOMETRY),
    });
    const res = await ctrl.quote(clientReq as never, soloDto);
    expect(res.soloFare).toEqual(solo.fare);
    expect(res.distanceM).toBe(10197);
    expect(res.geometry).toEqual(GEOMETRY);
    expect(res.quoteToken).toBe('quote.tok');
    expect(quoteToken.sign).toHaveBeenCalledWith(
      expect.objectContaining({ soloFareCents: 18500, originLat: 26.1445 }),
    );
  });

  it('rejects a non-client caller before quoting', async () => {
    const quoteSolo = vi.fn();
    const { ctrl } = makeController({ quoteSolo, getRouteGeometry: vi.fn() });
    await expect(ctrl.quote({ user: jwtDriver() } as never, soloDto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(quoteSolo).not.toHaveBeenCalled();
  });

  it('prices a scheduled quote like a normal one (no longer NotImplemented — RCAB-E6.S2)', async () => {
    const { ctrl } = makeController({
      quoteSolo: vi.fn().mockResolvedValue(solo),
      getRouteGeometry: vi.fn().mockResolvedValue(GEOMETRY),
    });
    const res = await ctrl.quote(clientReq as never, { ...(soloDto as object), type: RideType.Scheduled } as never);
    expect(res.soloFare).toEqual(solo.fare);
    expect(res.quoteToken).toBe('quote.tok');
  });
});

describe('RidesController.create — normal (solo) path', () => {
  beforeEach(() => vi.clearAllMocks());

  const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
  const dto = {
    type: RideType.Normal,
    originLat: 26.1445,
    originLng: 91.7362,
    destLat: 26.1758,
    destLng: 91.7898,
    quoteToken: 'quote.tok',
  } as never;
  const claims = {
    originLat: 26.1445,
    originLng: 91.7362,
    destLat: 26.1758,
    destLng: 91.7898,
    soloFareCents: 18500,
    distanceM: 10197,
    durationS: 796,
  };
  const row = soloRideRow;

  it('creates a requested ride with the fare locked from the quote token', async () => {
    const ridesCreate = vi.fn().mockResolvedValue({ row: row(), created: true });
    const { ctrl, redis, events, bus } = makeController({
      verify: vi.fn().mockReturnValue(claims),
      ridesCreate,
    });
    const res = await ctrl.create(clientReq as never, dto, 'idem-1');
    expect(res).toEqual({
      rideId: 'ride-9',
      passengerId: 'c-1',
      status: 'requested',
      fare: { amount: 18500, currency: 'INR' },
    });
    expect(ridesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ passengerId: 'c-1', fareCents: 18500, idempotencyKey: 'idem-1' }),
    );
    expect(redis.set).toHaveBeenCalledWith('idem:rides:idem-1', 'ride-9', 'EX', 86_400);
    // The booking client joins the ride room so it receives ride_state_changed.
    expect(bus.joinRide).toHaveBeenCalledWith('c-1', 'ride-9');
    // A freshly-created ride triggers dispatch.
    expect(events.emit).toHaveBeenCalledWith('ride.requested', { rideId: 'ride-9' });
  });

  it('replays the original ride from Redis without inserting again', async () => {
    const ridesCreate = vi.fn();
    const { ctrl, events } = makeController({
      redisGet: vi.fn().mockResolvedValue('ride-9'),
      ridesFindById: vi.fn().mockResolvedValue(row()),
      ridesCreate,
    });
    const res = await ctrl.create(clientReq as never, dto, 'idem-1');
    expect((res as { rideId: string }).rideId).toBe('ride-9');
    expect(ridesCreate).not.toHaveBeenCalled();
    // A replay must not re-dispatch.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('returns the same ride for a duplicate key when not in Redis (DB backstop)', async () => {
    const ridesCreate = vi.fn().mockResolvedValue({ row: row(), created: false });
    const { ctrl, events } = makeController({
      verify: vi.fn().mockReturnValue(claims),
      ridesCreate,
    });
    const res = await ctrl.create(clientReq as never, dto, 'idem-1');
    expect((res as { rideId: string }).rideId).toBe('ride-9');
    expect(ridesCreate).toHaveBeenCalledTimes(1);
    // Duplicate key (already existed) → no re-dispatch.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('400 when the Idempotency-Key header is missing', async () => {
    const { ctrl } = makeController({ verify: vi.fn().mockReturnValue(claims) });
    await expect(ctrl.create(clientReq as never, dto, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400 when the quote token is missing', async () => {
    const { ctrl } = makeController();
    const noToken = { ...(dto as object), quoteToken: undefined } as never;
    await expect(ctrl.create(clientReq as never, noToken, 'idem-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400 quote_expired when the token has expired', async () => {
    const verify = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    });
    const { ctrl } = makeController({ verify });
    await expect(ctrl.create(clientReq as never, dto, 'idem-1')).rejects.toMatchObject({
      response: { code: 'quote_expired' },
    });
  });

  it('400 invalid_quote when the token is tampered', async () => {
    const verify = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('invalid signature'), { name: 'JsonWebTokenError' });
    });
    const { ctrl } = makeController({ verify });
    await expect(ctrl.create(clientReq as never, dto, 'idem-1')).rejects.toMatchObject({
      response: { code: 'invalid_quote' },
    });
  });

  it('400 quote_mismatch when the token coords differ from the request', async () => {
    const verify = vi.fn().mockReturnValue({ ...claims, destLat: 27.0 });
    const ridesCreate = vi.fn();
    const { ctrl } = makeController({ verify, ridesCreate });
    await expect(ctrl.create(clientReq as never, dto, 'idem-1')).rejects.toMatchObject({
      response: { code: 'quote_mismatch' },
    });
    expect(ridesCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-client caller', async () => {
    const { ctrl } = makeController();
    await expect(ctrl.create({ user: jwtDriver() } as never, dto, 'idem-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('routes type=shared to the matching service (no regression)', async () => {
    const { ctrl, matching, repo } = makeController({ ride: ride({ poolState: 'open' }) });
    matching.findOrCreatePool.mockResolvedValue({
      sharedRideId: 'pool-1',
      mode: 'opened',
      poolStatus: 'open',
    });
    repo.findById.mockResolvedValue(null); // priceMatchedSeat → null path
    const sharedDto = { ...(dto as object), type: RideType.Shared } as never;
    const res = await ctrl.create(clientReq as never, sharedDto, undefined);
    expect(matching.findOrCreatePool).toHaveBeenCalled();
    expect((res as { sharedRideId: string }).sharedRideId).toBe('pool-1');
  });
});

describe('RidesController.create — scheduled path (RCAB-E6.S2)', () => {
  beforeEach(() => vi.clearAllMocks());

  const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
  const claims = {
    originLat: 26.1445,
    originLng: 91.7362,
    destLat: 26.1758,
    destLng: 91.7898,
    soloFareCents: 18500,
    distanceM: 10197,
    durationS: 796,
  };
  function scheduledDto(scheduledFor: string | undefined) {
    return {
      type: RideType.Scheduled,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      quoteToken: 'quote.tok',
      scheduledFor,
    } as never;
  }
  const inWindow = () => new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h out

  it('persists type=scheduled with scheduled_for and enqueues a wake — NOT immediate dispatch', async () => {
    const when = inWindow();
    const ridesCreate = vi
      .fn()
      .mockResolvedValue({ row: soloRideRow({ type: 'scheduled' }), created: true });
    const { ctrl, events, scheduled, bus } = makeController({
      verify: vi.fn().mockReturnValue(claims),
      ridesCreate,
    });

    const res = await ctrl.create(clientReq as never, scheduledDto(when), 'idem-1');

    expect((res as { rideId: string }).rideId).toBe('ride-9');
    expect(ridesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduled', scheduledFor: new Date(when) }),
    );
    expect(scheduled.scheduleWake).toHaveBeenCalledWith('ride-9', new Date(when));
    expect(bus.joinRide).toHaveBeenCalledWith('c-1', 'ride-9');
    // Scheduled rides must NOT dispatch now.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('a replay does not re-schedule the wake', async () => {
    const { ctrl, scheduled } = makeController({
      redisGet: vi.fn().mockResolvedValue('ride-9'),
      ridesFindById: vi.fn().mockResolvedValue(soloRideRow({ type: 'scheduled' })),
    });
    await ctrl.create(clientReq as never, scheduledDto(inWindow()), 'idem-1');
    expect(scheduled.scheduleWake).not.toHaveBeenCalled();
  });

  it('400 scheduled_for_required when the timestamp is missing', async () => {
    const { ctrl } = makeController({ verify: vi.fn().mockReturnValue(claims) });
    await expect(ctrl.create(clientReq as never, scheduledDto(undefined), 'idem-1')).rejects.toMatchObject(
      { response: { code: 'scheduled_for_required' } },
    );
  });

  it('400 out_of_window when sooner than 15 min', async () => {
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { ctrl, scheduled } = makeController({ verify: vi.fn().mockReturnValue(claims) });
    await expect(ctrl.create(clientReq as never, scheduledDto(soon), 'idem-1')).rejects.toMatchObject({
      response: { code: 'scheduled_for_out_of_window' },
    });
    expect(scheduled.scheduleWake).not.toHaveBeenCalled();
  });

  it('400 out_of_window when further than 24 h', async () => {
    const far = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    const { ctrl } = makeController({ verify: vi.fn().mockReturnValue(claims) });
    await expect(ctrl.create(clientReq as never, scheduledDto(far), 'idem-1')).rejects.toMatchObject({
      response: { code: 'scheduled_for_out_of_window' },
    });
  });
});

describe('RidesController.transition', () => {
  beforeEach(() => vi.clearAllMocks());

  const driverReq = { user: jwtDriver() };
  const body = (event: string) => ({ event }) as never;

  it('200 + new status on a legal transition, delegating to the state machine', async () => {
    const apply = vi.fn().mockResolvedValue({
      ok: true,
      row: soloRideRow({ id: RIDE_ID, status: 'en_route', driverId: DRIVER_ID }),
    });
    const { ctrl } = makeController({ apply });
    const res = await ctrl.transition(driverReq as never, RIDE_ID, body('start_en_route'));
    expect(res).toEqual({ rideId: RIDE_ID, status: 'en_route' });
    expect(apply).toHaveBeenCalledWith(RIDE_ID, DRIVER_ID, 'start_en_route');
  });

  it('409 ConflictException on invalid_transition (out-of-order)', async () => {
    const { ctrl } = makeController({
      apply: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid_transition' }),
    });
    await expect(
      ctrl.transition(driverReq as never, RIDE_ID, body('start_ride')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('403 ForbiddenException on not_owner', async () => {
    const { ctrl } = makeController({
      apply: vi.fn().mockResolvedValue({ ok: false, reason: 'not_owner' }),
    });
    await expect(
      ctrl.transition(driverReq as never, RIDE_ID, body('start_en_route')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404 NotFoundException on not_found', async () => {
    const { ctrl } = makeController({
      apply: vi.fn().mockResolvedValue({ ok: false, reason: 'not_found' }),
    });
    await expect(
      ctrl.transition(driverReq as never, RIDE_ID, body('start_en_route')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 BadRequestException on unknown_event', async () => {
    const { ctrl } = makeController({
      apply: vi.fn().mockResolvedValue({ ok: false, reason: 'unknown_event' }),
    });
    await expect(
      ctrl.transition(driverReq as never, RIDE_ID, body('teleport')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('403 and never calls the state machine when the caller is not a driver', async () => {
    const { ctrl, stateMachine } = makeController();
    const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
    await expect(
      ctrl.transition(clientReq as never, RIDE_ID, body('start_en_route')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(stateMachine.apply).not.toHaveBeenCalled();
  });
});

describe('RidesController.getRide', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ride detail for the passenger', async () => {
    const r = soloRideRow({ status: 'en_route', passengerId: 'c-1', driverId: DRIVER_ID });
    const { ctrl } = makeController({ ridesFindById: vi.fn().mockResolvedValue(r) });
    const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
    const res = await ctrl.getRide(clientReq as never, 'ride-9');
    expect(res.status).toBe('en_route');
    expect(res.origin).toEqual({ lat: r.originLat, lng: r.originLng });
    expect(res.dropoff).toEqual({ lat: r.destLat, lng: r.destLng });
  });

  it('returns ride detail for the bound driver', async () => {
    const r = soloRideRow({ status: 'in_progress', passengerId: 'c-1', driverId: DRIVER_ID });
    const { ctrl } = makeController({ ridesFindById: vi.fn().mockResolvedValue(r) });
    const res = await ctrl.getRide({ user: jwtDriver() } as never, 'ride-9');
    expect(res.status).toBe('in_progress');
  });

  it('404 when the ride does not exist', async () => {
    const { ctrl } = makeController({ ridesFindById: vi.fn().mockResolvedValue(null) });
    const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
    await expect(ctrl.getRide(clientReq as never, 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('403 when the caller is neither passenger nor bound driver', async () => {
    const r = soloRideRow({ passengerId: 'c-1', driverId: DRIVER_ID });
    const { ctrl } = makeController({ ridesFindById: vi.fn().mockResolvedValue(r) });
    const strangerReq = { user: { sub: 'c-2', role: 'client' } as JwtPayload };
    await expect(ctrl.getRide(strangerReq as never, 'ride-9')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('exposes the cancellation trail (cancelledBy / cancelReason / cancelledAt)', async () => {
    const r = soloRideRow({
      status: 'cancelled',
      passengerId: 'c-1',
      cancelledBy: 'driver',
      cancelReason: 'vehicle issue',
      cancelledAt: new Date('2026-05-31T10:00:00.000Z'),
    });
    const { ctrl } = makeController({ ridesFindById: vi.fn().mockResolvedValue(r) });
    const res = await ctrl.getRide(
      { user: { sub: 'c-1', role: 'client' } as JwtPayload } as never,
      'ride-9',
    );
    expect(res.cancelledBy).toBe('driver');
    expect(res.cancelReason).toBe('vehicle issue');
    expect(res.timestamps.cancelledAt).toBe('2026-05-31T10:00:00.000Z');
  });
});

describe('RidesController.cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  const clientReq = { user: { sub: 'c-1', role: 'client' } as JwtPayload };
  const driverReq = { user: jwtDriver() };

  it('200 + cancelledBy on a client cancel, delegating to the state machine', async () => {
    const cancel = vi.fn().mockResolvedValue({
      ok: true,
      row: soloRideRow({ status: 'cancelled', cancelledBy: 'client' }),
    });
    const { ctrl } = makeController({ cancel });
    const res = await ctrl.cancel(clientReq as never, RIDE_ID, {});
    expect(res).toEqual({ rideId: 'ride-9', status: 'cancelled', cancelledBy: 'client' });
    expect(cancel).toHaveBeenCalledWith({
      rideId: RIDE_ID,
      actor: 'client',
      actorId: 'c-1',
      isNoShow: false,
      reason: null,
    });
  });

  it('drops the pending wake job when a SCHEDULED ride is cancelled (RCAB-E6.S4)', async () => {
    const cancel = vi.fn().mockResolvedValue({
      ok: true,
      row: soloRideRow({ status: 'cancelled', cancelledBy: 'client', type: 'scheduled' }),
    });
    const { ctrl, scheduled } = makeController({ cancel });
    await ctrl.cancel(clientReq as never, RIDE_ID, {});
    expect(scheduled.cancelWake).toHaveBeenCalledWith(RIDE_ID);
  });

  it('does NOT touch the wake queue when a NORMAL ride is cancelled', async () => {
    const cancel = vi.fn().mockResolvedValue({
      ok: true,
      row: soloRideRow({ status: 'cancelled', cancelledBy: 'client', type: 'normal' }),
    });
    const { ctrl, scheduled } = makeController({ cancel });
    await ctrl.cancel(clientReq as never, RIDE_ID, {});
    expect(scheduled.cancelWake).not.toHaveBeenCalled();
  });

  it('200 on a driver no-show (event=mark_no_show), passing isNoShow + reason', async () => {
    const cancel = vi.fn().mockResolvedValue({
      ok: true,
      row: soloRideRow({ status: 'no_show', cancelledBy: 'driver' }),
    });
    const { ctrl } = makeController({ cancel });
    const res = await ctrl.cancel(driverReq as never, RIDE_ID, { event: 'mark_no_show' });
    expect(res.status).toBe('no_show');
    expect(cancel).toHaveBeenCalledWith({
      rideId: RIDE_ID,
      actor: 'driver',
      actorId: DRIVER_ID,
      isNoShow: true,
      reason: 'no_show',
    });
  });

  it('400 when a driver cancels without a reason', async () => {
    const { ctrl, stateMachine } = makeController();
    await expect(ctrl.cancel(driverReq as never, RIDE_ID, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(stateMachine.cancel).not.toHaveBeenCalled();
  });

  it('403 when a client tries to report a no-show', async () => {
    const { ctrl, stateMachine } = makeController();
    await expect(
      ctrl.cancel(clientReq as never, RIDE_ID, { event: 'mark_no_show' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(stateMachine.cancel).not.toHaveBeenCalled();
  });

  it('409 ConflictException on invalid_transition (e.g. client cancel of an in_progress ride)', async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: false, reason: 'invalid_transition' });
    const { ctrl } = makeController({ cancel });
    await expect(ctrl.cancel(clientReq as never, RIDE_ID, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('409 ConflictException on no_show_too_early', async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: false, reason: 'no_show_too_early' });
    const { ctrl } = makeController({ cancel });
    await expect(
      ctrl.cancel(driverReq as never, RIDE_ID, { event: 'mark_no_show' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404 NotFoundException on not_found', async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: false, reason: 'not_found' });
    const { ctrl } = makeController({ cancel });
    await expect(ctrl.cancel(clientReq as never, RIDE_ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('403 ForbiddenException on not_owner', async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: false, reason: 'not_owner' });
    const { ctrl } = makeController({ cancel });
    await expect(ctrl.cancel(clientReq as never, RIDE_ID, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
