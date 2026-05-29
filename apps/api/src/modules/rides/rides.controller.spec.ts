import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RidesController } from './rides.controller';
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
  } = {},
) {
  const matching = {} as never;
  const pricing = {} as never;
  const repo = {
    findById: vi.fn().mockResolvedValue(opts.ride === undefined ? ride() : opts.ride),
  };
  const stops = {
    findByRideId: vi.fn().mockResolvedValue(opts.stops ?? []),
  };
  const ctrl = new RidesController(matching, pricing, repo as never, stops as never);
  return { ctrl, repo, stops };
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
