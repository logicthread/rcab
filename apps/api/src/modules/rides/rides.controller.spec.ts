import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
  const redis = {
    get: opts.redisGet ?? vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
  const events = { emit: vi.fn() };
  const ctrl = new RidesController(
    matching as never,
    pricing as never,
    repo as never,
    stops as never,
    routeSim as never,
    quoteToken as never,
    ridesRepo as never,
    events as never,
    redis as never,
  );
  return { ctrl, repo, stops, pricing, routeSim, quoteToken, ridesRepo, redis, events, matching };
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
  function row(overrides: Partial<RideRow> = {}): RideRow {
    return {
      id: 'ride-9',
      passengerId: 'c-1',
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      status: 'requested',
      idempotencyKey: 'idem-1',
      driverId: null,
      acceptedAt: null,
      ...overrides,
    };
  }

  it('creates a requested ride with the fare locked from the quote token', async () => {
    const ridesCreate = vi.fn().mockResolvedValue({ row: row(), created: true });
    const { ctrl, redis, events } = makeController({
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
