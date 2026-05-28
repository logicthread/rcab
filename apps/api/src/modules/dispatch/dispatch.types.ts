export interface OfferStop {
  type:          'pickup' | 'dropoff';
  lat:           number;
  lng:           number;
  passengerId:   string;
  sequenceIndex: number;
}

export interface SharedRideOfferPayload {
  offerId:      string;
  sharedRideId: string;
  ttlMs:        number;
  stops:        OfferStop[];
  passengerCount: number;
  waveNumber:   number;
}

export interface ClaimResult {
  ok:            boolean;
  reason:        'claimed' | 'already_taken' | 'not_closed' | 'not_found';
}
