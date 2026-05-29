'use client';

import { create } from 'zustand';
import {
  PRESET_TRIPS,
  type PresetTrip,
  type QuoteResponse,
  type RideType,
  type PoolStatus,
} from './types';

export type BookingStage =
  | 'idle'
  | 'quoting'
  | 'quoted'
  | 'requesting'
  | 'opened'
  | 'slotted'
  | 'solo_fallback'
  | 'error';

export interface BookingState {
  rideType: RideType;
  trip: PresetTrip;
  stage: BookingStage;
  quote: QuoteResponse | null;
  quoteError: string | null;
  sharedRideId: string | null;
  seatCount: number;
  poolStatus: PoolStatus | null;
  requestError: string | null;

  setRideType: (next: RideType) => void;
  setTrip: (trip: PresetTrip) => void;
  startQuoting: () => void;
  setQuote: (quote: QuoteResponse) => void;
  setQuoteError: (message: string) => void;
  startRequest: () => void;
  setOpened: (sharedRideId: string, seatCount: number, poolStatus: PoolStatus) => void;
  setSlotted: (sharedRideId: string, seatCount: number, poolStatus: PoolStatus) => void;
  applyPoolUpdate: (sharedRideId: string, seatCount: number, poolStatus: PoolStatus) => void;
  setRequestError: (message: string) => void;
  reset: () => void;
}

const INITIAL_STATE = {
  rideType: 'shared' as RideType,
  trip: PRESET_TRIPS[0],
  stage: 'idle' as BookingStage,
  quote: null,
  quoteError: null,
  sharedRideId: null,
  seatCount: 0,
  poolStatus: null,
  requestError: null,
};

export const useBookingStore = create<BookingState>((set, get) => ({
  ...INITIAL_STATE,

  setRideType(next) {
    if (next === get().rideType) return;
    set({ rideType: next, quote: null, stage: 'idle', quoteError: null });
  },

  setTrip(trip) {
    set({ trip, quote: null, stage: 'idle', quoteError: null });
  },

  startQuoting() {
    set({ stage: 'quoting', quoteError: null });
  },

  setQuote(quote) {
    set({ quote, stage: 'quoted', quoteError: null });
  },

  setQuoteError(message) {
    set({ stage: 'error', quoteError: message });
  },

  startRequest() {
    set({ stage: 'requesting', requestError: null });
  },

  setOpened(sharedRideId, seatCount, poolStatus) {
    set({ stage: 'opened', sharedRideId, seatCount, poolStatus });
  },

  setSlotted(sharedRideId, seatCount, poolStatus) {
    set({ stage: 'slotted', sharedRideId, seatCount, poolStatus });
  },

  applyPoolUpdate(sharedRideId, seatCount, poolStatus) {
    const state = get();
    if (state.sharedRideId !== sharedRideId) return;
    if (poolStatus === 'closed_timeout' && seatCount === 1) {
      set({ seatCount, poolStatus, stage: 'solo_fallback' });
      return;
    }
    set({ seatCount, poolStatus });
  },

  setRequestError(message) {
    set({ stage: 'error', requestError: message });
  },

  reset() {
    set({ ...INITIAL_STATE });
  },
}));
