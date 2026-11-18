export interface OfferStop {
  type: 'pickup' | 'dropoff';
  lat: number;
  lng: number;
  passengerId: string;
  sequenceIndex: number;
}

export interface SharedRideOfferPayload {
  offerId: string;
  sharedRideId: string;
  ttlMs: number;
  /** Authoritative deadline (DB clock) — the client countdown is advisory. */
  expiresAt: string;
  stops: OfferStop[];
  passengerCount: number;
  waveNumber: number;
}

export interface SoloRideOfferPayload {
  offerId: string;
  rideId: string;
  ttlMs: number;
  /** Authoritative deadline (DB clock) — the client countdown is advisory. */
  expiresAt: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  fareCents: number;
  waveNumber: number;
  /** Road distance / time from the driver's current position to the pickup. */
  pickupDistanceM?: number;
  pickupDurationS?: number;
  /** Offered to a driver still finishing a ride: accepting queues this ride behind it. */
  nextRide?: boolean;
}

/** A trip in either table. The offer row — never the client — names it (F05). */
export type TripRef = { kind: 'solo'; rideId: string } | { kind: 'shared'; sharedRideId: string };

export function tripId(trip: TripRef): string {
  return trip.kind === 'solo' ? trip.rideId : trip.sharedRideId;
}

export type AcceptOfferFailure =
  /** Unknown id OR not this driver's offer (no existence leak). */
  | 'offer_not_found'
  | 'offer_expired'
  | 'offer_declined'
  | 'offer_revoked'
  /** offer.generation ≠ trip.dispatch_generation. */
  | 'offer_stale'
  /** Another driver holds the assignment / accepted offer for this trip. */
  | 'trip_taken'
  /** Solo not 'requested'; pool not closed_full|closed_timeout (or aborted). */
  | 'trip_not_claimable'
  /** Shared: ride_stops were not persisted at closure. */
  | 'itinerary_missing'
  /** The driver already holds another active trip (solo or shared). */
  | 'driver_busy'
  /** app_user not an active driver / no driver row. */
  | 'driver_ineligible'
  /** No active vehicle with seats ≥ the trip's need. */
  | 'vehicle_capacity'
  /** Bounded deadlock / serialization retry exhausted. */
  | 'conflict';

export type AcceptOfferResult =
  /** `queued`: accepted as the driver's NEXT ride while they finish their active one. */
  | { ok: true; trip: TripRef; generation: number; replay: boolean; queued?: boolean }
  | { ok: false; reason: AcceptOfferFailure };

export type DeclineOfferResult = 'declined' | 'not_found' | 'not_live';
