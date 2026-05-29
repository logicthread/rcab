import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RidesController } from './rides.controller';
import { RideType } from './dto/create-ride.dto';
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
  } = {},
) {
  const matching = {} as never;
  const pricing = {
    quoteSolo: opts.quoteSolo ?? vi.fn(),
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
  const ctrl = new RidesController(
    matching,
    pricing as never,
    repo as never,
    stops as never,
    routeSim as never,
  );
  return { ctrl, repo, stops, pricing, routeSim };
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

  it('includes the OSRM route geometry alongside the solo fare', async () => {
    const { ctrl } = makeController({
      quoteSolo: vi.fn().mockResolvedValue(solo),
      getRouteGeometry: vi.fn().mockResolvedValue(GEOMETRY),
    });
    const res = await ctrl.quote(clientReq as never, soloDto);
    expect(res.soloFare).toEqual(solo.fare);
    expect(res.distanceM).toBe(10197);
    expect(res.durationS).toBe(796);
    expect(res.geometry).toEqual(GEOMETRY);
    expect(res.geometry.coordinates.length).toBeGreaterThan(2);
  });

  it('fetches fare and geometry from the same origin/dest pair', async () => {
    const quoteSolo = vi.fn().mockResolvedValue(solo);
    const getRouteGeometry = vi.fn().mockResolvedValue(GEOMETRY);
    const { ctrl } = makeController({ quoteSolo, getRouteGeometry });
    await ctrl.quote(clientReq as never, soloDto);
    const expectedRoute = expect.objectContaining({
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
    });
    expect(quoteSolo).toHaveBeenCalledWith(expectedRoute);
    expect(getRouteGeometry).toHaveBeenCalledWith(expectedRoute);
  });

  it('rejects a non-client caller before quoting', async () => {
    const quoteSolo = vi.fn();
    const getRouteGeometry = vi.fn();
    const { ctrl } = makeController({ quoteSolo, getRouteGeometry });
    await expect(ctrl.quote({ user: jwtDriver() } as never, soloDto)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(quoteSolo).not.toHaveBeenCalled();
    expect(getRouteGeometry).not.toHaveBeenCalled();
  });
});
