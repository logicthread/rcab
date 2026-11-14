export type RideType = 'shared' | 'private';

export type ApiRideType = 'shared' | 'normal' | 'scheduled';

export interface Money {
  amount: number;
  currency: 'INR';
}

/** GeoJSON LineString of the OSRM road route. Coordinates are [lng, lat]. */
export interface RouteGeometry {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface QuoteResponse {
  type: ApiRideType;
  distanceM: number;
  durationS: number;
  soloFare: Money;
  geometry: RouteGeometry;
  /** Signed 5-min token locking fare + route; replayed into POST /v1/rides (solo). */
  quoteToken: string;
  sharedEstimate?: {
    perSeatPrice: Money;
    seatMultiplier: number;
    detourFactor: number;
    seatCount: number;
  };
}

export type PoolStatus =
  | 'open'
  | 'closed_full'
  | 'closed_timeout'
  | 'closed_started'
  | 'completed'
  | 'aborted';

export interface CreateRideResponse {
  sharedRideId: string;
  passengerId: string;
  mode: 'opened' | 'slotted';
  poolStatus: PoolStatus;
  /**
   * Per-seat fare this passenger agreed to, fixed at join (Phase-0 stand-in
   * policy `fixed_at_join`; RCAB-E8.S9 revisits it). Always present on success.
   */
  perSeatPrice: Money;
  farePolicy?: 'fixed_at_join';
  seatMultiplier?: number;
  detourFactor?: number;
}

/**
 * Versioned pool event (R09). `version` is the pool's `state_version`; the
 * socket wrapper drops any event not newer than what it already applied.
 * Also produced from a `pool:snapshot`.
 */
export interface PoolUpdateEvent {
  sharedRideId: string;
  seatCount: number;
  poolStatus: PoolStatus;
  version?: number;
  maxSeats?: number;
  terminal?: boolean;
  driverId?: string | null;
}

/** Authoritative pool state for this member (server `pool:snapshot`). */
export interface PoolSnapshotEvent extends PoolUpdateEvent {
  version: number;
  completedAt: string | null;
  me: {
    active: boolean;
    quotedFareCents: number | null;
    pickup: { lat: number; lng: number };
    dropoff: { lat: number; lng: number };
  };
  itinerary: Array<{
    sequenceIndex: number;
    type: 'pickup' | 'dropoff';
    mine: boolean;
    confirmed: boolean;
  }>;
}

/** Response of POST /v1/rides with type=normal (solo). */
export interface SoloRideResponse {
  rideId: string;
  passengerId: string;
  status: string;
  fare: Money;
  /** Scheduled rides only: requested pickup instant (ISO-8601). */
  scheduledFor?: string;
}

/** Forward solo lifecycle states the rider's tracking view reacts to (RCAB-E4.S7). */
export type RideStatus =
  | 'requested'
  | 'dispatching'
  | 'accepted'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'no_driver'
  | 'cancelled'
  | 'no_show';

/** Live driver position fanned out to the ride room (≤ 1 Hz). */
export interface DriverLocationEvent {
  rideId: string;
  lat: number;
  lng: number;
  heading: number;
}

/** Ride lifecycle transition echoed to the ride room (also produced from a `ride:snapshot`). */
export interface RideStateChangedEvent {
  rideId: string;
  state: string;
  by: string;
  /** Status rank; absent on legacy emits (the wrapper derives it from `state`). */
  version?: number;
  /**
   * Only set when produced from a `ride:snapshot` of a scheduled ride that is
   * still searching: ISO instant after which the server stops retrying. Absent
   * or null = the server did not send a cutoff.
   */
  retryUntil?: string | null;
}

/**
 * `ride_dispatch_retry` (scheduled rides): the accept window closed with no
 * driver and the server re-armed the search. Sent to the passenger on the first
 * re-arm; `retryUntil` is the server's retry cutoff (RCAB-E8.S13).
 */
export interface RideDispatchRetryEvent {
  rideId: string;
  retryCount: number;
  retryUntil?: string | null;
}

/** Authoritative solo ride state (server `ride:snapshot`). */
export interface RideSnapshotEvent {
  rideId: string;
  version: number;
  status: string;
  terminal: boolean;
  driverId: string | null;
  /** Scheduled rides still searching only; see `RideStateChangedEvent.retryUntil`. */
  retryUntil?: string | null;
}

/** Subset of GET /v1/rides/:id used to rehydrate the tracking view on reload. */
export interface RideDetailResponse {
  rideId: string;
  passengerId: string;
  driverId: string | null;
  status: string;
  fare: Money;
  origin: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  /** Scheduled rides: requested pickup instant (ISO-8601); null/absent for a normal ride. */
  scheduledFor?: string | null;
}

/** A point chosen on the map / via search, with a human-readable label. */
export interface Place {
  lat: number;
  lng: number;
  label: string;
}

/** Which endpoint a map tap or search selection sets. */
export type PointField = 'pickup' | 'dropoff';

/** Quick-pick seed trips. Guwahati (NE-India) — within the dev OSRM graph. */
export interface PresetTrip {
  id: string;
  label: string;
  pickup: Place;
  dropoff: Place;
}

export const PRESET_TRIPS: PresetTrip[] = [
  {
    id: 'paltanbazaar-zooroad',
    label: 'Paltan Bazaar → Zoo Road',
    pickup: { lat: 26.175, lng: 91.751, label: 'Paltan Bazaar, Guwahati' },
    dropoff: { lat: 26.167, lng: 91.7898, label: 'Zoo Road, Guwahati' },
  },
  {
    id: 'fancybazaar-dispur',
    label: 'Fancy Bazaar → Dispur',
    pickup: { lat: 26.1855, lng: 91.746, label: 'Fancy Bazaar, Guwahati' },
    dropoff: { lat: 26.141, lng: 91.79, label: 'Dispur, Guwahati' },
  },
  {
    id: 'guwahaticlub-ganeshguri',
    label: 'Guwahati Club → Ganeshguri',
    pickup: { lat: 26.181, lng: 91.77, label: 'Guwahati Club' },
    dropoff: { lat: 26.148, lng: 91.792, label: 'Ganeshguri' },
  },
];

/** Map default centre: Guwahati city centre (matches the dev OSRM graph). */
export const MAP_DEFAULT_CENTER: Place = {
  lat: 26.1445,
  lng: 91.7362,
  label: 'Guwahati',
};

export function apiRideType(rideType: RideType): ApiRideType {
  return rideType === 'shared' ? 'shared' : 'normal';
}
