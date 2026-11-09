import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { useAuthStore } from '../../lib/auth/store';
import { useBookingStore } from '../../lib/booking/store';
import { PRESET_TRIPS, type QuoteResponse } from '../../lib/booking/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="map" /> }));
vi.mock('../../lib/geo/nominatim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/geo/nominatim')>()),
  reverseGeocode: vi.fn(),
}));
const wsConn = vi.hoisted(() => ({
  poolHandler: null as null | ((p: unknown) => void),
  stateHandler: null as null | ((p: unknown) => void),
  retryHandler: null as null | ((p: unknown) => void),
  subscribePool: vi.fn(),
  subscribeRide: vi.fn(),
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
    onRideStateChanged: (h: (p: unknown) => void) => {
      wsConn.stateHandler = h;
      return () => undefined;
    },
    onDispatchRetry: (h: (p: unknown) => void) => {
      wsConn.retryHandler = h;
      return () => undefined;
    },
    subscribePool: wsConn.subscribePool,
    subscribeRide: wsConn.subscribeRide,
    close: () => undefined,
  })),
}));
vi.mock('../../lib/booking/api', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/booking/api')>('../../lib/booking/api');
  return {
    ...actual,
    fetchQuote: vi.fn(),
    fetchRide: vi.fn(),
    createNormalRide: vi.fn(),
    createSharedRide: vi.fn(),
    cancelRide: vi.fn(),
    submitRating: vi.fn(),
  };
});

import BookClient from './book-client';
import * as api from '../../lib/booking/api';

const fetchQuote = vi.mocked(api.fetchQuote);
const createNormalRide = vi.mocked(api.createNormalRide);
const createSharedRide = vi.mocked(api.createSharedRide);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function quote(token: string, fare = 5000): QuoteResponse {
  return {
    type: 'normal',
    distanceM: 4200,
    durationS: 600,
    soloFare: { amount: fare, currency: 'INR' },
    quoteToken: token,
    geometry: { type: 'LineString', coordinates: [[91.75, 26.17]] },
  };
}

function pickPreset(i: number) {
  fireEvent.click(screen.getByText(PRESET_TRIPS[i].label));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useBookingStore.getState().reset();
  useAuthStore.setState({
    user: { id: 'u1', role: 'client', phone_e164: '+911234567890' },
    jwt: 'jwt',
    jwtExpiresAt: null,
    signedOut: false,
  });
});

describe('BookPage quote flow (F01)', () => {
  it('delayed success: quote arrives after a slow request and enables booking', async () => {
    const d = deferred<QuoteResponse>();
    fetchQuote.mockReturnValueOnce(d.promise);
    render(<BookClient />);
    pickPreset(0);

    await screen.findByText('Pricing…');
    expect(screen.getByTestId('submit-shared')).toBeDisabled();
    // The request must NOT have been cancelled by its own stage change.
    expect(fetchQuote).toHaveBeenCalledTimes(1);
    const signal = fetchQuote.mock.calls[0][3] as AbortSignal;
    expect(signal.aborted).toBe(false);

    await act(async () => d.resolve(quote('q1')));

    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());
    expect(screen.queryByText('Pricing…')).not.toBeInTheDocument();
    expect(useBookingStore.getState().stage).toBe('quoted');
    expect(fetchQuote).toHaveBeenCalledTimes(1);
  });

  it('delayed error surfaces the message, and Retry re-quotes the same route', async () => {
    const d = deferred<QuoteResponse>();
    fetchQuote.mockReturnValueOnce(d.promise);
    render(<BookClient />);
    pickPreset(0);
    await screen.findByText('Pricing…');

    await act(async () => d.reject(new api.BookingApiError(500, 'boom', 'Server exploded')));
    expect(await screen.findByTestId('quote-error')).toHaveTextContent('Server exploded');
    expect(fetchQuote).toHaveBeenCalledTimes(1);

    fetchQuote.mockResolvedValueOnce(quote('q-retry'));
    fireEvent.click(screen.getByTestId('quote-retry'));

    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());
    expect(fetchQuote).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('quote-error')).not.toBeInTheDocument();
  });

  it('route change mid-flight: aborts the old request and ignores its late response', async () => {
    const first = deferred<QuoteResponse>();
    const second = deferred<QuoteResponse>();
    fetchQuote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<BookClient />);
    pickPreset(0);
    await screen.findByText('Pricing…');

    pickPreset(1);
    await waitFor(() => expect(fetchQuote).toHaveBeenCalledTimes(2));
    expect((fetchQuote.mock.calls[0][3] as AbortSignal).aborted).toBe(true);
    expect((fetchQuote.mock.calls[1][3] as AbortSignal).aborted).toBe(false);

    await act(async () => second.resolve(quote('q-new', 9900)));
    await waitFor(() => expect(useBookingStore.getState().quote?.quoteToken).toBe('q-new'));
    // The superseded response lands late and must not overwrite the newer quote.
    await act(async () => first.resolve(quote('q-stale', 100)));
    expect(useBookingStore.getState().quote?.quoteToken).toBe('q-new');
    expect(useBookingStore.getState().stage).toBe('quoted');
  });

  it('StrictMode double-invoke does not strand the page in "Pricing…"', async () => {
    fetchQuote.mockResolvedValue(quote('q-strict'));
    render(
      <StrictMode>
        <BookClient />
      </StrictMode>,
    );
    pickPreset(0);

    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());
    expect(screen.queryByText('Pricing…')).not.toBeInTheDocument();
    expect(useBookingStore.getState().quote?.quoteToken).toBe('q-strict');
  });

  it('a label-only reverse-geocode update keeps the valid quote and does not re-quote', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());

    act(() => {
      const p = useBookingStore.getState().pickup!;
      useBookingStore.getState().setPoint('pickup', { ...p, label: 'Renamed' });
    });

    expect(useBookingStore.getState().quote?.quoteToken).toBe('q1');
    expect(screen.getByTestId('submit-shared')).toBeEnabled();
    expect(fetchQuote).toHaveBeenCalledTimes(1);
  });

  it('does not re-quote when only the access token is refreshed', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());

    act(() => useAuthStore.setState({ jwt: 'jwt-refreshed' }));

    expect(fetchQuote).toHaveBeenCalledTimes(1);
    expect(useBookingStore.getState().quote?.quoteToken).toBe('q1');
  });
});

describe('BookPage re-quotes when the quote is cleared without a coordinate change (F01)', () => {
  it('re-applying the same preset clears the quote and fetches a fresh one, exactly once', async () => {
    fetchQuote.mockResolvedValueOnce(quote('q1')).mockResolvedValueOnce(quote('q2'));
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(useBookingStore.getState().quote?.quoteToken).toBe('q1'));
    expect(fetchQuote).toHaveBeenCalledTimes(1);

    // Same coordinates -> same quoteKey; the store still wipes the quote.
    pickPreset(0);
    await waitFor(() => expect(useBookingStore.getState().quote?.quoteToken).toBe('q2'));
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());
    expect(fetchQuote).toHaveBeenCalledTimes(2);
    expect(useBookingStore.getState().stage).toBe('quoted');
  });

  it('a direct store invalidation never strands the page without a quote or a request', async () => {
    fetchQuote.mockResolvedValueOnce(quote('q1')).mockResolvedValueOnce(quote('q2'));
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());

    act(() => useBookingStore.getState().invalidateQuote());

    await waitFor(() => expect(useBookingStore.getState().quote?.quoteToken).toBe('q2'));
    expect(fetchQuote).toHaveBeenCalledTimes(2);
  });

  it('private: quote_expired at submit re-quotes, rotates the key and books with the new token', async () => {
    fetchQuote.mockResolvedValueOnce(quote('q-old')).mockResolvedValueOnce(quote('q-new'));
    createNormalRide
      .mockRejectedValueOnce(
        new api.BookingApiError(400, 'quote_expired', 'Quote expired — please re-quote'),
      )
      .mockResolvedValueOnce({
        rideId: 'r1',
        passengerId: 'u1',
        status: 'requested',
        fare: { amount: 5000, currency: 'INR' as const },
      });
    render(<BookClient />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());

    fireEvent.click(screen.getByTestId('submit-private'));
    await screen.findByText(/quote expired/i);
    await waitFor(() => expect(useBookingStore.getState().quote?.quoteToken).toBe('q-new'));
    expect(fetchQuote).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());

    fireEvent.click(screen.getByTestId('submit-private'));
    await waitFor(() => expect(createNormalRide).toHaveBeenCalledTimes(2));
    expect(createNormalRide.mock.calls[1][2]).toBe('q-new');
    expect(createNormalRide.mock.calls[1][3]).not.toBe(createNormalRide.mock.calls[0][3]);
  });
});

describe('BookPage idempotency key per booking intent (F18a)', () => {
  it('private: a failed submit retried for the same intent reuses the key; success rotates it', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    createNormalRide
      .mockRejectedValueOnce(new api.BookingApiError(504, 'timeout', 'gateway timeout'))
      .mockResolvedValueOnce({
        rideId: 'r1',
        passengerId: 'u1',
        status: 'requested',
        fare: { amount: 5000, currency: 'INR' },
      });
    render(<BookClient />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());

    fireEvent.click(screen.getByTestId('submit-private'));
    await screen.findByText('gateway timeout');
    fireEvent.click(screen.getByTestId('submit-private'));
    await waitFor(() => expect(createNormalRide).toHaveBeenCalledTimes(2));

    const k1 = createNormalRide.mock.calls[0][3];
    const k2 = createNormalRide.mock.calls[1][3];
    expect(k1).toBeTruthy();
    expect(k2).toBe(k1);
  });

  it('private: changing the route mints a new key', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    createNormalRide.mockRejectedValue(new api.BookingApiError(504, 'timeout', 'gateway timeout'));
    render(<BookClient />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());
    fireEvent.click(screen.getByTestId('submit-private'));
    await screen.findByText('gateway timeout');

    pickPreset(1);
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());
    fireEvent.click(screen.getByTestId('submit-private'));
    await waitFor(() => expect(createNormalRide).toHaveBeenCalledTimes(2));

    expect(createNormalRide.mock.calls[1][3]).not.toBe(createNormalRide.mock.calls[0][3]);
  });

  it('shared: submit sends an idempotency key and reuses it across a retry', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    createSharedRide
      .mockRejectedValueOnce(new api.BookingApiError(504, 'timeout', 'gateway timeout'))
      .mockResolvedValueOnce({
        sharedRideId: 'sr1',
        passengerId: 'u1',
        mode: 'opened',
        poolStatus: 'open',
        perSeatPrice: { amount: 7_000, currency: 'INR' },
      });
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());

    fireEvent.click(screen.getByTestId('submit-shared'));
    await screen.findByText('gateway timeout');
    fireEvent.click(screen.getByTestId('submit-shared'));
    await waitFor(() => expect(createSharedRide).toHaveBeenCalledTimes(2));

    const k1 = createSharedRide.mock.calls[0][2];
    expect(k1).toBeTruthy();
    expect(createSharedRide.mock.calls[1][2]).toBe(k1);
    // The fare agreed at join is shown, fixed.
    expect((await screen.findByTestId('agreed-fare')).textContent).toContain('₹70.00');
  });
});

describe('BookPage pool realtime wiring (F10)', () => {
  it('subscribes the pool explicitly after create and applies the versioned state it receives', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    createSharedRide.mockResolvedValueOnce({
      sharedRideId: 'sr-7',
      passengerId: 'u1',
      mode: 'opened',
      poolStatus: 'open',
      perSeatPrice: { amount: 7_000, currency: 'INR' },
    });
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());
    fireEvent.click(screen.getByTestId('submit-shared'));

    await waitFor(() => expect(wsConn.subscribePool).toHaveBeenCalledWith('sr-7'));
    act(() => {
      wsConn.poolHandler?.({
        sharedRideId: 'sr-7',
        seatCount: 2,
        poolStatus: 'closed_full',
        version: 4,
      });
    });
    expect(useBookingStore.getState().seatCount).toBe(2);
    expect(useBookingStore.getState().poolStatus).toBe('closed_full');
  });
});

describe('BookPage idempotency error recovery', () => {
  const ride = {
    rideId: 'r1',
    passengerId: 'u1',
    status: 'requested',
    fare: { amount: 5000, currency: 'INR' as const },
  };

  it('private: 422 idempotency_key_conflict rotates the key and re-quotes', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    createNormalRide
      .mockRejectedValueOnce(
        new api.BookingApiError(
          422,
          'idempotency_key_conflict',
          'key used for a different request',
        ),
      )
      .mockResolvedValueOnce(ride);
    render(<BookClient />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());
    expect(fetchQuote).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('submit-private'));
    await screen.findByText(/refreshed the quote/i);
    await waitFor(() => expect(fetchQuote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());

    fireEvent.click(screen.getByTestId('submit-private'));
    await waitFor(() => expect(createNormalRide).toHaveBeenCalledTimes(2));
    expect(createNormalRide.mock.calls[1][3]).not.toBe(createNormalRide.mock.calls[0][3]);
  });

  it('shared: 400 idempotency_key_invalid rotates the key', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    createSharedRide
      .mockRejectedValueOnce(new api.BookingApiError(400, 'idempotency_key_invalid', 'bad key'))
      .mockResolvedValueOnce({
        sharedRideId: 'sr1',
        passengerId: 'u1',
        mode: 'opened',
        poolStatus: 'open',
        perSeatPrice: { amount: 7_000, currency: 'INR' },
      });
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());

    fireEvent.click(screen.getByTestId('submit-shared'));
    await screen.findByText(/try again/i);
    fireEvent.click(screen.getByTestId('submit-shared'));
    await waitFor(() => expect(createSharedRide).toHaveBeenCalledTimes(2));
    expect(createSharedRide.mock.calls[1][2]).not.toBe(createSharedRide.mock.calls[0][2]);
  });

  it('private: a still-in-progress 409 keeps the key for the manual retry', async () => {
    fetchQuote.mockResolvedValue(quote('q1'));
    createNormalRide
      .mockRejectedValueOnce(
        new api.BookingApiError(409, 'idempotency_request_in_progress', 'in progress'),
      )
      .mockResolvedValueOnce(ride);
    render(<BookClient />);
    fireEvent.click(screen.getByRole('radio', { name: 'Private' }));
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-private')).toBeEnabled());

    fireEvent.click(screen.getByTestId('submit-private'));
    await screen.findByText(/still being processed/i);
    fireEvent.click(screen.getByTestId('submit-private'));
    await waitFor(() => expect(createNormalRide).toHaveBeenCalledTimes(2));
    expect(createNormalRide.mock.calls[1][3]).toBe(createNormalRide.mock.calls[0][3]);
  });
});

describe('BookPage reload restore', () => {
  it('a saved ride that is already no_show is not resumed and its marker is cleared', async () => {
    window.localStorage.setItem('rcab_active_ride', 'r-ns');
    vi.mocked(api.fetchRide).mockResolvedValue({
      rideId: 'r-ns',
      status: 'no_show',
      origin: { lat: 26.14, lng: 91.73 },
      dropoff: { lat: 26.17, lng: 91.78 },
    } as never);
    render(<BookClient />);
    await waitFor(() => expect(window.localStorage.getItem('rcab_active_ride')).toBeNull());
    expect(screen.queryByTestId('tracking-panel')).toBeNull();
    expect(useBookingStore.getState().rideId).toBeNull();
  });
});

describe('BookPage sign out (F12)', () => {
  it('Sign out calls signOut and clears booking state + the persisted active ride', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ signOut });
    window.localStorage.setItem('rcab_active_ride', 'r-old');
    vi.mocked(api.fetchRide).mockReturnValue(new Promise(() => undefined));
    fetchQuote.mockResolvedValue(quote('q1'));
    render(<BookClient />);
    pickPreset(0);
    await waitFor(() => expect(screen.getByTestId('submit-shared')).toBeEnabled());

    fireEvent.click(screen.getByText('Sign out'));

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('rcab_active_ride')).toBeNull();
    expect(useBookingStore.getState().pickup).toBeNull();
    expect(useBookingStore.getState().quote).toBeNull();
  });
});

describe('BookPage scheduled searching state (RCAB-E8.S13)', () => {
  const UNTIL = '2026-11-08T10:30:00.000Z';
  const untilText = new Date(UNTIL).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function track(status = 'requested') {
    act(() => {
      useBookingStore.getState().setSoloRequested('r-sched', status);
    });
  }

  beforeEach(() => {
    wsConn.stateHandler = null;
    wsConn.retryHandler = null;
  });

  it('ride_dispatch_retry flips the tracking banner to "still looking ... until <time>" with a Cancel button', async () => {
    render(<BookClient />);
    track();
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Finding your driver');
    await waitFor(() => expect(wsConn.retryHandler).not.toBeNull());

    act(() => wsConn.retryHandler!({ rideId: 'r-sched', retryCount: 1, retryUntil: UNTIL }));

    const banner = screen.getByTestId('tracking-status');
    expect(banner).toHaveTextContent(/Still looking for a driver/);
    expect(banner).toHaveTextContent(`we'll keep trying until ${untilText}`);
    expect(screen.getByTestId('tracking-cancel')).toBeInTheDocument();
  });

  it('a ride:snapshot (requested + retryUntil) restores the searching state after a reload/reconnect', async () => {
    render(<BookClient />);
    track();
    await waitFor(() => expect(wsConn.stateHandler).not.toBeNull());

    act(() =>
      wsConn.stateHandler!({ rideId: 'r-sched', state: 'requested', by: 'snapshot', version: 1, retryUntil: UNTIL }),
    );
    expect(screen.getByTestId('tracking-status')).toHaveTextContent(`until ${untilText}`);
  });

  it('shows no time when the server sent none', async () => {
    render(<BookClient />);
    track();
    await waitFor(() => expect(wsConn.retryHandler).not.toBeNull());
    act(() => wsConn.retryHandler!({ rideId: 'r-sched', retryCount: 1 }));
    const banner = screen.getByTestId('tracking-status');
    expect(banner).toHaveTextContent("Still looking for a driver — we'll keep trying");
    expect(banner).not.toHaveTextContent(/until/);
  });

  it('the terminal no_driver replaces the searching banner with the normal no-driver message', async () => {
    render(<BookClient />);
    track();
    await waitFor(() => expect(wsConn.retryHandler).not.toBeNull());
    act(() => wsConn.retryHandler!({ rideId: 'r-sched', retryCount: 1, retryUntil: UNTIL }));
    act(() => wsConn.stateHandler!({ rideId: 'r-sched', state: 'no_driver', by: 'system', version: 10 }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('No driver available — please try again');
    expect(screen.queryByTestId('tracking-cancel')).not.toBeInTheDocument();
    expect(useBookingStore.getState().searchRetry).toBeNull();
  });

  it('Cancel from the searching state cancels the ride', async () => {
    vi.mocked(api.cancelRide).mockResolvedValue({ rideId: 'r-sched', status: 'cancelled' } as never);
    render(<BookClient />);
    track();
    await waitFor(() => expect(wsConn.retryHandler).not.toBeNull());
    act(() => wsConn.retryHandler!({ rideId: 'r-sched', retryCount: 1, retryUntil: UNTIL }));
    fireEvent.click(screen.getByTestId('tracking-cancel'));
    await waitFor(() => expect(api.cancelRide).toHaveBeenCalledWith('r-sched'));
    await waitFor(() =>
      expect(screen.getByTestId('tracking-status')).toHaveTextContent('Ride cancelled'),
    );
  });
});
