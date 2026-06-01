import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RatingService } from './rating.service';
import type { RideRow } from '../rides/rides.repository';
import type { RatingRow } from './rating.repository';

const RIDE_ID = 'ride-1';
const PASSENGER_ID = 'passenger-1';
const DRIVER_ID = 'driver-1';

function completedRide(overrides: Partial<RideRow> = {}): RideRow {
  return {
    id: RIDE_ID,
    passengerId: PASSENGER_ID,
    originLat: 0,
    originLng: 0,
    destLat: 0,
    destLng: 0,
    fareCents: 18500,
    status: 'completed',
    idempotencyKey: 'idem-1',
    driverId: DRIVER_ID,
    acceptedAt: new Date(),
    enRouteAt: new Date(),
    arrivedAt: new Date(),
    startedAt: new Date(),
    completedAt: new Date(),
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    ...overrides,
  };
}

function ratingRow(overrides: Partial<RatingRow> = {}): RatingRow {
  return {
    id: 'rating-1',
    rideId: RIDE_ID,
    raterId: PASSENGER_ID,
    subjectId: DRIVER_ID,
    stars: 5,
    text: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('RatingService.rate', () => {
  let ridesRepo: { findById: ReturnType<typeof vi.fn> };
  let ratingRepo: { insert: ReturnType<typeof vi.fn> };
  let svc: RatingService;

  beforeEach(() => {
    ridesRepo = { findById: vi.fn() };
    ratingRepo = { insert: vi.fn() };
    svc = new RatingService(ridesRepo as never, ratingRepo as never);
  });

  it('client rates the bound driver on a completed ride', async () => {
    ridesRepo.findById.mockResolvedValue(completedRide());
    ratingRepo.insert.mockResolvedValue(ratingRow({ subjectId: DRIVER_ID }));

    const res = await svc.rate({ rideId: RIDE_ID, raterId: PASSENGER_ID, stars: 5, text: 'great' });

    expect(res.ok).toBe(true);
    expect(ratingRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        rideId: RIDE_ID,
        raterId: PASSENGER_ID,
        subjectId: DRIVER_ID,
        stars: 5,
        text: 'great',
      }),
    );
  });

  it('driver rates the passenger on a completed ride', async () => {
    ridesRepo.findById.mockResolvedValue(completedRide());
    ratingRepo.insert.mockResolvedValue(ratingRow({ raterId: DRIVER_ID, subjectId: PASSENGER_ID }));

    const res = await svc.rate({ rideId: RIDE_ID, raterId: DRIVER_ID, stars: 4, text: null });

    expect(res.ok).toBe(true);
    expect(ratingRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ raterId: DRIVER_ID, subjectId: PASSENGER_ID }),
    );
  });

  it('rejects a rater who is not a party to the ride (no insert)', async () => {
    ridesRepo.findById.mockResolvedValue(completedRide());

    const res = await svc.rate({ rideId: RIDE_ID, raterId: 'stranger', stars: 5, text: null });

    expect(res).toEqual({ ok: false, reason: 'not_a_party' });
    expect(ratingRepo.insert).not.toHaveBeenCalled();
  });

  it('rejects rating a ride that is not completed (no insert)', async () => {
    ridesRepo.findById.mockResolvedValue(completedRide({ status: 'in_progress' }));

    const res = await svc.rate({ rideId: RIDE_ID, raterId: PASSENGER_ID, stars: 5, text: null });

    expect(res).toEqual({ ok: false, reason: 'not_completed' });
    expect(ratingRepo.insert).not.toHaveBeenCalled();
  });

  it('maps a duplicate (conflict → null insert) to already_rated', async () => {
    ridesRepo.findById.mockResolvedValue(completedRide());
    ratingRepo.insert.mockResolvedValue(null);

    const res = await svc.rate({ rideId: RIDE_ID, raterId: PASSENGER_ID, stars: 5, text: null });

    expect(res).toEqual({ ok: false, reason: 'already_rated' });
  });

  it('returns not_found for an unknown ride (no insert)', async () => {
    ridesRepo.findById.mockResolvedValue(null);

    const res = await svc.rate({ rideId: 'nope', raterId: PASSENGER_ID, stars: 5, text: null });

    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(ratingRepo.insert).not.toHaveBeenCalled();
  });

  it('treats a completed ride with no bound driver as not_a_party (defensive)', async () => {
    ridesRepo.findById.mockResolvedValue(completedRide({ driverId: null }));

    const res = await svc.rate({ rideId: RIDE_ID, raterId: PASSENGER_ID, stars: 5, text: null });

    expect(res).toEqual({ ok: false, reason: 'not_a_party' });
    expect(ratingRepo.insert).not.toHaveBeenCalled();
  });
});
