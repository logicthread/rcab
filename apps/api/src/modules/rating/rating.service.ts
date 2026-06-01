import { Injectable } from '@nestjs/common';
import { RidesRepository } from '../rides/rides.repository';
import { RatingRepository, type RatingRow } from './rating.repository';

/**
 * Result of a rating attempt. The four failure reasons map to HTTP
 * 404 / 403 / 409 / 409 at the controller. RCAB-E4.S9.
 */
export type RateResult =
  | { ok: true; rating: RatingRow }
  | { ok: false; reason: 'not_found' | 'not_a_party' | 'not_completed' | 'already_rated' };

@Injectable()
export class RatingService {
  constructor(
    private readonly ridesRepo: RidesRepository,
    private readonly ratingRepo: RatingRepository,
  ) {}

  /**
   * Capture one rating for a completed solo ride. The subject is the OTHER party,
   * resolved from the ride row: a client (passenger) rates the bound driver; the
   * driver rates the passenger. Only a `completed` ride is rateable, and only its
   * two parties may rate it. A repeat submission for the same direction is
   * `already_rated` (the UNIQUE backstop). No aggregation runs here — the raw row
   * is consumed by the E7 aggregation later. RCAB-E4.S9.
   */
  async rate(params: {
    rideId: string;
    raterId: string;
    stars: number;
    text: string | null;
  }): Promise<RateResult> {
    const ride = await this.ridesRepo.findById(params.rideId);
    if (!ride) return { ok: false, reason: 'not_found' };
    if (ride.status !== 'completed') return { ok: false, reason: 'not_completed' };

    let subjectId: string | null;
    if (params.raterId === ride.passengerId) subjectId = ride.driverId;
    else if (params.raterId === ride.driverId) subjectId = ride.passengerId;
    else return { ok: false, reason: 'not_a_party' };
    // A completed ride always has a bound driver; guard the impossible null so a
    // malformed row can't yield a null-subject rating.
    if (!subjectId) return { ok: false, reason: 'not_a_party' };

    const rating = await this.ratingRepo.insert({
      rideId: ride.id,
      raterId: params.raterId,
      subjectId,
      stars: params.stars,
      text: params.text,
    });
    if (!rating) return { ok: false, reason: 'already_rated' };
    return { ok: true, rating };
  }
}
