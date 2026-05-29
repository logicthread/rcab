'use client';

import { create } from 'zustand';
import {
  type Place,
  type PointField,
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
  pickup: Place | null;
  dropoff: Place | null;
  activeField: PointField;
  stage: BookingStage;
  quote: QuoteResponse | null;
  quoteError: string | null;
  sharedRideId: string | null;
  seatCount: number;
  poolStatus: PoolStatus | null;
  requestError: string | null;

  setRideType: (next: RideType) => void;
  setActiveField: (field: PointField) => void;
  setPoint: (field: PointField, place: Place) => void;
  applyPreset: (trip: PresetTrip) => void;
  swapPoints: () => void;
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
  pickup: null as Place | null,
  dropoff: null as Place | null,
  activeField: 'pickup' as PointField,
  stage: 'idle' as BookingStage,
  quote: null as QuoteResponse | null,
  quoteError: null as string | null,
  sharedRideId: null as string | null,
  seatCount: 0,
  poolStatus: null as PoolStatus | null,
  requestError: null as string | null,
};

// Any change to the chosen points invalidates the current quote.
const CLEAR_QUOTE = { quote: null, quoteError: null, stage: 'idle' as BookingStage };

export const useBookingStore = create<BookingState>((set, get) => ({
  ...INITIAL_STATE,

  setRideType(next) {
    if (next === get().rideType) return;
    set({ rideType: next, ...CLEAR_QUOTE });
  },

  setActiveField(field) {
    set({ activeField: field });
  },

  setPoint(field, place) {
    const other: PointField = field === 'pickup' ? 'dropoff' : 'pickup';
    // After setting a point, move focus to the other endpoint if it's still empty.
    const nextActive = get()[other] === null ? other : field;
    set({ [field]: place, activeField: nextActive, ...CLEAR_QUOTE } as Partial<BookingState>);
  },

  applyPreset(trip) {
    set({ pickup: trip.pickup, dropoff: trip.dropoff, activeField: 'pickup', ...CLEAR_QUOTE });
  },

  swapPoints() {
    const { pickup, dropoff } = get();
    set({ pickup: dropoff, dropoff: pickup, ...CLEAR_QUOTE });
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
