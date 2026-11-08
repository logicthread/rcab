'use client';

import { create } from 'zustand';
import {
  type Money,
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
  // Bumped every time the quote is invalidated (CLEAR_QUOTE). The quote effect
  // depends on it so a clear that leaves the coordinates unchanged (same preset
  // re-applied, quote expired at submit, ...) still triggers a fresh quote.
  quoteEpoch: number;
  sharedRideId: string | null;
  seatCount: number;
  poolStatus: PoolStatus | null;
  // Fare this passenger agreed to at join (fixed; never readjusted by later joins).
  agreedFare: Money | null;
  requestError: string | null;

  // Solo (normal) live-tracking — RCAB-E4.S7.
  rideId: string | null;
  rideStatus: RideStatus | null;
  driver: DriverPosition | null;
  // Scheduled ride whose search was re-armed (or whose snapshot says it is still
  // searching): the server keeps trying, optionally until `retryUntil` (ISO).
  // Null for every other ride and for any non-searching status. RCAB-E8.S13.
  searchRetry: { retryUntil: string | null } | null;
  // Whether the rider has rated (or skipped) this completed ride — RCAB-E4.S9.
  rated: boolean;

  setRideType: (next: RideType) => void;
  setActiveField: (field: PointField) => void;
  setPoint: (field: PointField, place: Place) => void;
  applyPreset: (trip: PresetTrip) => void;
  swapPoints: () => void;
  /** Drop the current quote (e.g. expired at submit) and request a fresh one. */
  invalidateQuote: () => void;
  startQuoting: () => void;
  setQuote: (quote: QuoteResponse) => void;
  setQuoteError: (message: string) => void;
  startRequest: () => void;
  setOpened: (
    sharedRideId: string,
    seatCount: number,
    poolStatus: PoolStatus,
    agreedFare?: Money,
  ) => void;
  setSlotted: (
    sharedRideId: string,
    seatCount: number,
    poolStatus: PoolStatus,
    agreedFare?: Money,
  ) => void;
  applyPoolUpdate: (sharedRideId: string, seatCount: number, poolStatus: PoolStatus) => void;
  setRequestError: (message: string) => void;
  setSoloRequested: (rideId: string, status: string) => void;
  /** `retryUntil`: from a `ride:snapshot` of a searching scheduled ride (undefined = no information). */
  applyRideState: (state: string, retryUntil?: string | null) => void;
  /** `ride_dispatch_retry` for the active ride; ignored once the ride is no longer searching. */
  applyDispatchRetry: (rideId: string, retryUntil?: string | null) => void;
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
  quoteEpoch: 0,
  sharedRideId: null as string | null,
  seatCount: 0,
  poolStatus: null as PoolStatus | null,
  agreedFare: null as Money | null,
  requestError: null as string | null,
  rideId: null as string | null,
  rideStatus: null as RideStatus | null,
  driver: null as DriverPosition | null,
  searchRetry: null as { retryUntil: string | null } | null,
  rated: false,
};

// The API emits a fixed lifecycle vocabulary; anything unexpected falls back to
// `requested` so the banner stays sane rather than rendering a raw string.
const KNOWN_STATUSES: readonly RideStatus[] = [
  'requested',
  'dispatching',
  'accepted',
  'en_route',
  'arrived',
  'in_progress',
  'completed',
  'no_driver',
  'cancelled',
  'no_show',
];

/** Statuses in which the server is still looking for a driver. */
export function isSearching(status: RideStatus | null): boolean {
  return status === 'requested' || status === 'dispatching';
}

function normalizeStatus(state: string): RideStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(state)
    ? (state as RideStatus)
    : 'requested';
}

// Any change to the chosen points invalidates the current quote.
const CLEAR_QUOTE = { quote: null, quoteError: null, stage: 'idle' as BookingStage };
const clearQuote = (epoch: number) => ({ ...CLEAR_QUOTE, quoteEpoch: epoch + 1 });

export const useBookingStore = create<BookingState>((set, get) => ({
  ...INITIAL_STATE,

  setRideType(next) {
    if (next === get().rideType) return;
    set({ rideType: next, ...clearQuote(get().quoteEpoch) });
  },

  setActiveField(field) {
    set({ activeField: field });
  },

  setPoint(field, place) {
    const existing = get()[field];
    // Same coordinates, new label (reverse-geocode landing): the route is
    // unchanged, so keep the valid quote instead of wiping it.
    if (existing && existing.lat === place.lat && existing.lng === place.lng) {
      set({ [field]: place } as Partial<BookingState>);
      return;
    }
    const other: PointField = field === 'pickup' ? 'dropoff' : 'pickup';
    // After setting a point, move focus to the other endpoint if it's still empty.
    const nextActive = get()[other] === null ? other : field;
    set({
      [field]: place,
      activeField: nextActive,
      ...clearQuote(get().quoteEpoch),
    } as Partial<BookingState>);
  },

  applyPreset(trip) {
    set({
      pickup: trip.pickup,
      dropoff: trip.dropoff,
      activeField: 'pickup',
      ...clearQuote(get().quoteEpoch),
    });
  },

  swapPoints() {
    const { pickup, dropoff } = get();
    set({ pickup: dropoff, dropoff: pickup, ...clearQuote(get().quoteEpoch) });
  },

  invalidateQuote() {
    set({ ...clearQuote(get().quoteEpoch) });
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

  setOpened(sharedRideId, seatCount, poolStatus, agreedFare) {
    set({ stage: 'opened', sharedRideId, seatCount, poolStatus, agreedFare: agreedFare ?? null });
  },

  setSlotted(sharedRideId, seatCount, poolStatus, agreedFare) {
    set({ stage: 'slotted', sharedRideId, seatCount, poolStatus, agreedFare: agreedFare ?? null });
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
      searchRetry: null,
      rated: false,
      stage: 'tracking',
    });
  },

  applyRideState(state, retryUntil) {
    // Only the active ride's transitions matter; the socket is per-ride so this
    // is the live ride, but guard against a late event after reset.
    if (get().rideId === null) return;
    const rideStatus = normalizeStatus(state);
    if (!isSearching(rideStatus)) {
      // Accepted / cancelled / no_driver / ...: the search overlay is over.
      set({ rideStatus, searchRetry: null });
      return;
    }
    // A snapshot of a searching scheduled ride carries the cutoff; a plain
    // `requested` event (retryUntil undefined) keeps what we already know.
    set(
      typeof retryUntil === 'string'
        ? { rideStatus, searchRetry: { retryUntil } }
        : { rideStatus },
    );
  },

  applyDispatchRetry(rideId, retryUntil) {
    const state = get();
    if (state.rideId !== rideId || !isSearching(state.rideStatus)) return;
    // Keep a cutoff we already know if this event does not repeat it.
    const known = state.searchRetry?.retryUntil ?? null;
    set({ searchRetry: { retryUntil: typeof retryUntil === 'string' ? retryUntil : known } });
  },

  applyDriverLocation(rideId, lat, lng, heading) {
    if (get().rideId !== rideId) return;
    set({ driver: { lat, lng, heading } });
  },

  markRated() {
    set({ rated: true });
  },

  reset() {
    set({ ...INITIAL_STATE, quoteEpoch: get().quoteEpoch + 1 });
  },
}));
