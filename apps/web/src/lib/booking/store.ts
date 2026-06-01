'use client';

import { create } from 'zustand';
import {
  type Place,
  type PointField,
  type PresetTrip,
  type QuoteResponse,
  type RideType,
  type RideStatus,
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
  | 'tracking'
  | 'error';

export interface DriverPosition {
  lat: number;
  lng: number;
  heading: number;
}

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

  // Solo (normal) live-tracking — RCAB-E4.S7.
  rideId: string | null;
  rideStatus: RideStatus | null;
  driver: DriverPosition | null;
  // Whether the rider has rated (or skipped) this completed ride — RCAB-E4.S9.
  rated: boolean;

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
  setSoloRequested: (rideId: string, status: string) => void;
  applyRideState: (state: string) => void;
  applyDriverLocation: (rideId: string, lat: number, lng: number, heading: number) => void;
  markRated: () => void;
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
  rideId: null as string | null,
  rideStatus: null as RideStatus | null,
  driver: null as DriverPosition | null,
  rated: false,
};

// The API emits a fixed lifecycle vocabulary; anything unexpected falls back to
// `requested` so the banner stays sane rather than rendering a raw string.
const KNOWN_STATUSES: readonly RideStatus[] = [
  'requested',
  'accepted',
  'en_route',
  'arrived',
  'in_progress',
  'completed',
  'no_driver',
  'cancelled',
  'no_show',
];

function normalizeStatus(state: string): RideStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(state)
    ? (state as RideStatus)
    : 'requested';
}

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

  setSoloRequested(rideId, status) {
    set({
      rideId,
      rideStatus: normalizeStatus(status),
      driver: null,
      rated: false,
      stage: 'tracking',
    });
  },

  applyRideState(state) {
    // Only the active ride's transitions matter; the socket is per-ride so this
    // is the live ride, but guard against a late event after reset.
    if (get().rideId === null) return;
    set({ rideStatus: normalizeStatus(state) });
  },

  applyDriverLocation(rideId, lat, lng, heading) {
    if (get().rideId !== rideId) return;
    set({ driver: { lat, lng, heading } });
  },

  markRated() {
    set({ rated: true });
  },

  reset() {
    set({ ...INITIAL_STATE });
  },
}));
