import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { useAuthStore } from '../../lib/auth/store';
import { useBookingStore } from '../../lib/booking/store';
import { FEATURES } from '../../config/features';
import { PRESET_TRIPS, type QuoteResponse } from '../../lib/booking/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="map" /> }));
vi.mock('../../lib/geo/nominatim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/geo/nominatim')>()),
  reverseGeocode: vi.fn(),
}));
const wsConn = vi.hoisted(() => ({
  poolHandler: null as null | ((p: unknown) => void),
}));
vi.mock('../../lib/booking/ws', () => ({
  connectBookingSocket: vi.fn(() => ({
    socket: {},
    onPoolUpdate: (h: (p: unknown) => void) => {
      wsConn.poolHandler = h;
      return () => undefined;
    },
    onPoolSnapshot: () => () => undefined,
    onDriverLocation: () => () => undefined,
    onRideStateChanged: () => () => undefined,
    onDispatchRetry: () => () => undefined,
    subscribePool: vi.fn(),
    subscribeRide: vi.fn(),
    close: () => undefined,
  })),
}));
vi.mock('../../lib/booking/api', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/booking/api')>('../../lib/booking/api');
  return {
    ...actual,
    fetchQuote: vi.fn(),
    snapToRoad: vi.fn(async (lat: number, lng: number) => ({ lat, lng, distanceM: 0 })),
    fetchRide: vi.fn(),
    createNormalRide: vi.fn(),
    createScheduledRide: vi.fn(),
    createSharedRide: vi.fn(),
    cancelRide: vi.fn(),
    submitRating: vi.fn(),
  };
});

import BookClient from './book-client';
import * as api from '../../lib/booking/api';

const fetchQuote = vi.mocked(api.fetchQuote);
const createSharedRide = vi.mocked(api.createSharedRide);

const QUOTE: QuoteResponse = {
  type: 'normal',
  distanceM: 4200,
  durationS: 600,
  soloFare: { amount: 5000, currency: 'INR' },
  quoteToken: 'q1',
  geometry: { type: 'LineString', coordinates: [[91.75, 26.17]] },
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useBookingStore.getState().clearAll();
  useAuthStore.setState({
    user: { id: 'u1', role: 'client', phone_e164: '+911234567890' },
    jwt: 'jwt',
    jwtExpiresAt: null,
    signedOut: false,
  });
});

afterEach(() => {
  FEATURES.sharedRides = false; // the shipped default (test-setup)
});

describe('BookPage with shared rides switched off', () => {
  beforeEach(() => {
    FEATURES.sharedRides = false;
    useBookingStore.getState().clearAll();
  });

  it('shows Share as coming soon (not selectable) and books private', async () => {
    fetchQuote.mockResolvedValue(QUOTE);
    render(<BookClient />);
    expect(screen.getByRole('radio', { name: 'Share' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Private' })).toBeChecked();
    expect(useBookingStore.getState().rideType).toBe('private');
    fireEvent.click(screen.getByText(PRESET_TRIPS[0].label));
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());
    expect(screen.queryByTestId('submit-shared')).toBeNull();
  });

  it('offers every vehicle, defaulting to Cab, and remembers the choice', () => {
    render(<BookClient />);
    const picker = screen.getByRole('radiogroup', { name: 'Vehicle' });
    const labels = Array.from(picker.querySelectorAll('[role="radio"]')).map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Bike', 'Auto', 'Cab', 'SUV', '6 seater']);
    expect(screen.getByTestId('vehicle-cab')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByTestId('vehicle-suv'));
    expect(screen.getByTestId('vehicle-suv')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('vehicle-cab')).toHaveAttribute('aria-checked', 'false');
    expect(useBookingStore.getState().vehicle).toBe('suv');
  });
});

describe('BookPage after a shared ride exists', () => {
  beforeEach(() => {
    FEATURES.sharedRides = true; // shared rides back on: the booking starts as Share
    useBookingStore.getState().clearAll();
  });

  it('replaces the booking form with the pool view, including once the trip starts', async () => {
    fetchQuote.mockResolvedValue(QUOTE);
    createSharedRide.mockResolvedValueOnce({
      sharedRideId: 'sr-1',
      passengerId: 'u1',
      mode: 'opened',
      poolStatus: 'open',
      perSeatPrice: { amount: 7_000, currency: 'INR' },
    });
    render(<BookClient />);
    fireEvent.click(screen.getByText(PRESET_TRIPS[0].label));
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());
    fireEvent.click(screen.getByTestId('submit-shared'));

    await screen.findByTestId('pool-status');
    expect(screen.queryByTestId('submit-shared')).toBeNull();
    expect(screen.queryByTestId('pickup-search')).toBeNull();

    act(() => {
      wsConn.poolHandler?.({
        sharedRideId: 'sr-1',
        seatCount: 2,
        poolStatus: 'closed_started',
        version: 5,
      });
    });
    const status = await screen.findByTestId('pool-status');
    expect(status.textContent).toContain('Trip under way');
    expect(screen.queryByTestId('quote-panel')).toBeNull();
    expect(screen.queryByTestId('vehicle-picker')).toBeNull();
  });
});

describe('BookPage snaps pickup and drop-off to the road', () => {
  const snapToRoad = vi.mocked(api.snapToRoad);
  const preset = PRESET_TRIPS[0];

  beforeEach(() => {
    FEATURES.sharedRides = false;
    useBookingStore.getState().clearAll();
  });

  it('quotes and stores the snapped coordinates, and says how far each point moved', async () => {
    fetchQuote.mockResolvedValue(QUOTE);
    snapToRoad.mockImplementation(async (lat) =>
      lat === preset.pickup.lat
        ? { lat: 26.174859, lng: 91.751124, distanceM: 20 }
        : { lat: 26.168209, lng: 91.788763, distanceM: 169 },
    );
    render(<BookClient />);
    fireEvent.click(screen.getByText(preset.label));

    await waitFor(() => expect(fetchQuote).toHaveBeenCalled());
    const [from, to] = fetchQuote.mock.calls[0];
    expect(from).toMatchObject({ lat: 26.174859, lng: 91.751124 });
    expect(to).toMatchObject({ lat: 26.168209, lng: 91.788763 });
    expect(useBookingStore.getState().pickup).toMatchObject({
      lat: 26.174859,
      label: preset.pickup.label,
    });
    const notes = screen.getAllByTestId('snap-note').map((n) => n.textContent);
    expect(notes).toEqual([
      'Pickup moved 20 m to the nearest road.',
      'Drop-off moved 169 m to the nearest road.',
    ]);
  });

  it('stays quiet when the point barely moved', async () => {
    fetchQuote.mockResolvedValue(QUOTE);
    snapToRoad.mockImplementation(async (lat, lng) => ({ lat, lng, distanceM: 6 }));
    render(<BookClient />);
    fireEvent.click(screen.getByText(preset.label));
    await waitFor(() => expect(fetchQuote).toHaveBeenCalled());
    expect(screen.queryByTestId('snap-note')).toBeNull();
  });

  it('refuses a point with no road nearby, tells the rider, and sets nothing', async () => {
    snapToRoad.mockRejectedValue(
      new api.BookingApiError(422, 'no_road_nearby', 'No road close enough to that spot.'),
    );
    render(<BookClient />);
    fireEvent.click(screen.getByText(preset.label));
    expect(await screen.findByTestId('snap-error')).toHaveTextContent('No road close enough');
    expect(useBookingStore.getState().pickup).toBeNull();
    expect(useBookingStore.getState().dropoff).toBeNull();
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it('keeps the point as picked when snapping itself is unavailable', async () => {
    fetchQuote.mockResolvedValue(QUOTE);
    snapToRoad.mockRejectedValue(new Error('network'));
    render(<BookClient />);
    fireEvent.click(screen.getByText(preset.label));
    await waitFor(() => expect(fetchQuote).toHaveBeenCalled());
    expect(useBookingStore.getState().pickup).toMatchObject({
      lat: preset.pickup.lat,
      lng: preset.pickup.lng,
    });
    expect(screen.queryByTestId('snap-error')).toBeNull();
  });
});
