export type RideType = 'shared' | 'private';

export type ApiRideType = 'shared' | 'normal' | 'scheduled';

export interface Money {
  amount: number;
  currency: 'INR';
}

export interface QuoteResponse {
  type: ApiRideType;
  distanceM: number;
  durationS: number;
  soloFare: Money;
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

export interface PresetTrip {
  id: string;
  label: string;
  originLat: number;
  originLng: number;
  originName: string;
  destLat: number;
  destLng: number;
  destName: string;
}

export const PRESET_TRIPS: PresetTrip[] = [
  {
    id: 'indiranagar-whitefield',
    label: 'Indiranagar → Whitefield',
    originLat: 12.9719,
    originLng: 77.6412,
    originName: 'Indiranagar',
    destLat: 12.9698,
    destLng: 77.7499,
    destName: 'Whitefield',
  },
  {
    id: 'koramangala-electronic-city',
    label: 'Koramangala → Electronic City',
    originLat: 12.9352,
    originLng: 77.6245,
    originName: 'Koramangala',
    destLat: 12.8452,
    destLng: 77.6602,
    destName: 'Electronic City',
  },
  {
    id: 'mg-road-airport',
    label: 'MG Road → Airport',
    originLat: 12.9756,
    originLng: 77.6094,
    originName: 'MG Road',
    destLat: 13.1986,
    destLng: 77.7066,
    destName: 'Kempegowda Intl',
  },
];

export function apiRideType(rideType: RideType): ApiRideType {
  return rideType === 'shared' ? 'shared' : 'normal';
}
