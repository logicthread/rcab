import type { Money } from './money';
import type { OfferStop } from '../dispatch/dispatch.types';
import type { SharedFarePolicy } from './shared-fare-policy';

export interface RouteSpec {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

export interface RouteMetrics {
  distanceM: number;
  durationS: number;
}

export interface SoloQuote extends RouteMetrics {
  fare: Money;
}

export interface SeatQuote {
  perSeatPrice: Money;
  seatMultiplier: number;
  detourFactor: number;
  /** The policy this quote was made under (Phase-0 stand-in: 'fixed_at_join'). */
  policy: SharedFarePolicy;
}

/**
 * Everything needed to price one seat, taken from the LOCKED pool state inside
 * the seat transaction.
 */
export interface SeatFareContext {
  poolId: string;
  /** The passenger being seated. */
  passengerId: string;
  /** Seat count AFTER this passenger is seated. */
  seatCount: number;
  /** The passenger's own direct origin -> destination route. */
  directRoute: RouteSpec;
  /**
   * The ordered multi-stop itinerary of the pool INCLUDING this passenger
   * (`computeStops`): every member's pickup precedes every dropoff.
   */
  stops: OfferStop[];
}

/**
 * Prices a seat. Called inside the join/open transaction; must throw (never
 * resolve to an absent price) when the fare cannot be determined, so the seat
 * is not committed.
 */
export type SeatFareQuoter = (ctx: SeatFareContext) => Promise<SeatQuote>;
