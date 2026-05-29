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
  sharedEstimate?: {
    perSeatPrice: Money;
    seatMultiplier: number;
    detourFactor: number;
    seatCount: number;
  };
}

export type PoolStatus = 'open' | 'closed_full' | 'closed_timeout';

export interface CreateRideResponse {
  sharedRideId: string;
  passengerId: string;
  mode: 'opened' | 'slotted';
  poolStatus: PoolStatus;
  perSeatPrice?: Money;
  seatMultiplier?: number;
  detourFactor?: number;
}

export interface PoolUpdateEvent {
  sharedRideId: string;
  seatCount: number;
  poolStatus: PoolStatus;
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
