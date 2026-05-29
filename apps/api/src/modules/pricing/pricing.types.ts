import type { Money } from './money';
import type { SharedRideRow } from '../matching/shared-ride.repository';

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
}

export interface SeatContext {
  /** the joining/opening passenger's direct origin → dest route */
  route: RouteSpec;
}

export type PoolForPricing = Pick<
  SharedRideRow,
  'rideId' | 'originLat' | 'originLng' | 'destLat' | 'destLng' | 'seatCount' | 'maxSeats'
>;
