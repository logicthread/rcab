'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { withAuth } from '../../lib/auth/with-auth';
import { useAuthStore } from '../../lib/auth/store';
import { useBookingStore } from '../../lib/booking/store';
import {
  MAP_DEFAULT_CENTER,
  PRESET_TRIPS,
  apiRideType,
  type Money,
  type Place,
  type PresetTrip,
} from '../../lib/booking/types';
import {
  BookingApiError,
  cancelRide,
  createNormalRide,
  createScheduledRide,
  createSharedRide,
  fetchQuote,
  fetchRide,
  submitRating,
} from '../../lib/booking/api';
import { connectBookingSocket } from '../../lib/booking/ws';
import { createIntentKeyTracker } from '../../lib/booking/intent';
import { reverseGeocode } from '../../lib/geo/nominatim';
import { AddressSearch } from './address-search';
import { validateSchedule } from '../../lib/booking/schedule';
import { RideTypeToggle } from './ride-type-toggle';
import { SchedulePicker } from './schedule-picker';
import { PoolBadge } from './pool-badge';
import { poolStatusLabel } from '../../lib/booking/pool-status';
import { SoloFallbackBanner } from './solo-fallback-banner';
import { RideTrackingPanel } from './ride-tracking-panel';

const ACTIVE_RIDE_KEY = 'rcab_active_ride';
// Terminal solo statuses: the persisted active-ride marker is dropped (and a reload
// does not resume tracking) once the ride reaches any of them. `no_show` is a terminal
// state the driver can put a ride into after the wait, so it must be here too.
const TERMINAL_RIDE_STATUSES: readonly string[] = ['completed', 'no_driver', 'cancelled', 'no_show'];

// Leaflet touches `window`, so the map is client-only (no SSR).
const MapPicker = dynamic(() => import('./map-picker').then((m) => m.MapPicker), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: 340,
        borderRadius: 8,
        background: '#f5f5f5',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#737373',
        fontSize: 13,
      }}
    >
      Loading map…
    </div>
  ),
});

function formatMoney(m: Money | null | undefined): string {
  if (!m) return '—';
  return `₹${(m.amount / 100).toFixed(2)}`;
}

const IDEMPOTENCY_CONFLICT_MSG =
  'Your booking details changed since the last attempt, so we refreshed the quote. Please review it and confirm again.';
const IDEMPOTENCY_IN_PROGRESS_MSG =
  'Your previous request is still being processed. Please wait a moment and try again.';
const IDEMPOTENCY_INVALID_MSG = 'Something went wrong preparing your request. Please try again.';

const QUOTE_EXPIRED_MSG =
  'Your fare quote expired, so we are refreshing it. Please review the new fare and confirm again.';

const ROUTING_UNAVAILABLE_MSG =
  "We can't route between these points yet — try pickup and drop within the city.";

function BookPage() {
  const { user, jwt, signOut } = useAuthStore();
  // Effects depend on *whether* we are authenticated, never on the token value:
  // a background token refresh must not re-run quotes or tear down sockets.
  const authed = jwt !== null;
  const getToken = useCallback(() => useAuthStore.getState().getAccessToken(), []);
  const {
    rideType,
    pickup,
    dropoff,
    activeField,
    stage,
    quote,
    quoteError,
    quoteEpoch,
    sharedRideId,
    seatCount,
    poolStatus,
    agreedFare,
    requestError,
    rideId,
    rideStatus,
    searchRetry,
    driver,
    rated,
    scheduledFor,
    setScheduledFor,
    setRideType,
    setActiveField,
    setPoint,
    applyPreset,
    swapPoints,
    invalidateQuote,
    startQuoting,
    setQuote,
    setQuoteError,
    startRequest,
    setOpened,
    setSlotted,
    applyPoolUpdate,
    setRequestError,
    setSoloRequested,
    applyRideState,
    applyDispatchRetry,
    applyDriverLocation,
    markRated,
    reset,
  } = useBookingStore();

  const bothSet = pickup !== null && dropoff !== null;
  // Request identity = ride type + route coordinates. Deliberately excludes
  // stage/quote/labels: those are changed *by* the request itself.
  const quoteKey = bothSet
    ? `${rideType}|${pickup!.lat},${pickup!.lng}|${dropoff!.lat},${dropoff!.lng}`
    : '';
  const tracking = stage === 'tracking';
  // Bumped by "Retry" to re-quote an unchanged route after an error/expiry.
  const [quoteNonce, setQuoteNonce] = useState(0);

  // Quote whenever both endpoints are set and the route (or ride type) changes,
  // or whenever the store invalidated the quote (quoteEpoch) — a clear that
  // leaves the coordinates untouched must still re-quote, otherwise the page
  // is left with no quote, no request and no retry control. quoteEpoch is only
  // bumped by clears, never by startQuoting/setQuote, so there is no loop and
  // the in-flight request is not aborted by its own stage change.
  // One AbortController per effect run: a superseded run (route change, unmount,
  // StrictMode double-invoke) aborts its fetch and can no longer apply state.
  useEffect(() => {
    if (!authed || !quoteKey || tracking) return;
    const { pickup: from, dropoff: to, rideType: type } = useBookingStore.getState();
    if (!from || !to) return;
    const controller = new AbortController();
    let superseded = false;
    startQuoting();
    fetchQuote(from, to, apiRideType(type), controller.signal)
      .then((res) => {
        if (!superseded) setQuote(res);
      })
      .catch((err: unknown) => {
        if (superseded) return;
        let message = 'Quote failed';
        if (err instanceof BookingApiError) {
          message = err.isRoutingUnavailable ? ROUTING_UNAVAILABLE_MSG : err.message;
        }
        setQuoteError(message);
      });
    return () => {
      superseded = true;
      controller.abort();
    };
  }, [quoteKey, quoteNonce, quoteEpoch, authed, tracking, startQuoting, setQuote, setQuoteError]);

  // One idempotency key per booking intent (ride type + route), reused across
  // retries and rotated only on a changed intent or a confirmed success.
  const intentKeys = useMemo(() => createIntentKeyTracker(), []);

  // Maps a failed create to user-facing copy, applying the idempotency recovery
  // the API contract requires:
  //  - 422 idempotency_key_conflict: the key now names a different request, so
  //    rotate it and re-quote (the fare/quote the user saw is stale).
  //  - 400 idempotency_key_invalid: rotate; a retry gets a fresh key.
  //  - 409 idempotency_request_in_progress: already replayed once in the api
  //    layer; keep the key so a manual retry still dedupes server-side.
  const createErrorMessage = useCallback(
    (err: unknown): string => {
      if (!(err instanceof BookingApiError)) return 'Request failed';
      if (err.isQuoteExpired) {
        // The quote token lapsed before submit: the booking was never created,
        // so rotate the key (the retry carries a new token) and re-quote.
        intentKeys.clear();
        invalidateQuote();
        return QUOTE_EXPIRED_MSG;
      }
      if (err.isIdempotencyConflict) {
        intentKeys.clear();
        setQuoteNonce((n) => n + 1);
        return IDEMPOTENCY_CONFLICT_MSG;
      }
      if (err.isIdempotencyKeyInvalid) {
        intentKeys.clear();
        return IDEMPOTENCY_INVALID_MSG;
      }
      if (err.isIdempotencyInProgress) return IDEMPOTENCY_IN_PROGRESS_MSG;
      return err.message;
    },
    [intentKeys, invalidateQuote],
  );

  // Shared pool: subscribe explicitly after create and on every reconnect (the
  // wrapper re-sends it). The server authorizes membership, then sends a
  // Postgres snapshot; only newer versioned updates are applied after it, so a
  // first booking or a dropped connection never misses a pool change (F10).
  useEffect(() => {
    if (!authed || !sharedRideId) return;
    const conn = connectBookingSocket(getToken);
    const unsub = conn.onPoolUpdate((payload) => {
      applyPoolUpdate(payload.sharedRideId, payload.seatCount, payload.poolStatus);
    });
    conn.subscribePool(sharedRideId);
    return () => {
      unsub();
      conn.close();
    };
  }, [authed, getToken, sharedRideId, applyPoolUpdate]);

  // Solo live-tracking: follow the ride room for status + driver position. The
  // subscribe (re-sent on every reconnect) returns an authoritative snapshot;
  // older / duplicate status events are dropped by the wrapper's version gate.
  useEffect(() => {
    if (!authed || !rideId) return;
    const conn = connectBookingSocket(getToken);
    const unsubState = conn.onRideStateChanged((p) => applyRideState(p.state, p.retryUntil));
    const unsubRetry = conn.onDispatchRetry((p) => applyDispatchRetry(p.rideId, p.retryUntil));
    const unsubLoc = conn.onDriverLocation((p) =>
      applyDriverLocation(p.rideId, p.lat, p.lng, p.heading),
    );
    conn.subscribeRide(rideId);
    return () => {
      unsubState();
      unsubRetry();
      unsubLoc();
      conn.close();
    };
  }, [authed, getToken, rideId, applyRideState, applyDispatchRetry, applyDriverLocation]);

  // Reconnect-restore: a saved active ride (full page reload) rehydrates the
  // tracking view from GET /v1/rides/:id; terminal rides clear the marker.
  useEffect(() => {
    if (!authed || rideId || sharedRideId) return;
    const saved =
      typeof window !== 'undefined' ? window.localStorage.getItem(ACTIVE_RIDE_KEY) : null;
    if (!saved) return;
    let cancelled = false;
    fetchRide(saved)
      .then((r) => {
        if (cancelled) return;
        if (TERMINAL_RIDE_STATUSES.includes(r.status)) {
          window.localStorage.removeItem(ACTIVE_RIDE_KEY);
          return;
        }
        useBookingStore.setState({
          pickup: { lat: r.origin.lat, lng: r.origin.lng, label: 'Pickup' },
          dropoff: { lat: r.dropoff.lat, lng: r.dropoff.lng, label: 'Dropoff' },
          rideType: 'private',
        });
        setSoloRequested(r.rideId, r.status, r.scheduledFor);
      })
      .catch(() => {
        /* stale / unauthorized — drop it */
        window.localStorage.removeItem(ACTIVE_RIDE_KEY);
      });
    return () => {
      cancelled = true;
    };
    // mount-time restore; deps intentionally minimal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Stop persisting a ride once it reaches a terminal state.
  useEffect(() => {
    if (
      rideStatus &&
      TERMINAL_RIDE_STATUSES.includes(rideStatus) &&
      typeof window !== 'undefined'
    ) {
      window.localStorage.removeItem(ACTIVE_RIDE_KEY);
    }
  }, [rideStatus]);

  const submitSolo = useCallback(async () => {
    if (!authed || rideType !== 'private' || !pickup || !dropoff || !quote?.quoteToken) return;
    if (scheduledFor) {
      const invalid = validateSchedule(scheduledFor);
      if (invalid) {
        setRequestError(invalid);
        return;
      }
    }
    startRequest();
    try {
      // A "Later" booking is a different intent (and a different server idempotency scope) than
      // "Now", and each pickup time is its own intent: the key follows both.
      const key = intentKeys.keyFor(scheduledFor ? `${quoteKey}|${scheduledFor}` : quoteKey);
      const res = scheduledFor
        ? await createScheduledRide(pickup, dropoff, quote.quoteToken, scheduledFor, key)
        : await createNormalRide(pickup, dropoff, quote.quoteToken, key);
      intentKeys.clear();
      if (typeof window !== 'undefined') window.localStorage.setItem(ACTIVE_RIDE_KEY, res.rideId);
      setSoloRequested(res.rideId, res.status, res.scheduledFor ?? scheduledFor);
    } catch (err) {
      setRequestError(createErrorMessage(err));
    }
  }, [
    authed,
    rideType,
    pickup,
    dropoff,
    quote,
    quoteKey,
    scheduledFor,
    intentKeys,
    startRequest,
    setSoloRequested,
    setRequestError,
    createErrorMessage,
  ]);

  // Tap the map → set the active endpoint, then resolve a human label.
  const handleMapClick = useCallback(
    async (lat: number, lng: number) => {
      const field = useBookingStore.getState().activeField;
      const coordLabel = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      setPoint(field, { lat, lng, label: coordLabel });
      try {
        const label = await reverseGeocode(lat, lng);
        const current = useBookingStore.getState()[field];
        if (current && current.lat === lat && current.lng === lng) {
          setPoint(field, { lat, lng, label });
        }
      } catch {
        /* keep the coordinate label */
      }
    },
    [setPoint],
  );

  const submit = useCallback(async () => {
    if (!authed || rideType !== 'shared' || !pickup || !dropoff) return;
    startRequest();
    try {
      const res = await createSharedRide(pickup, dropoff, intentKeys.keyFor(quoteKey));
      intentKeys.clear();
      if (res.mode === 'opened') {
        setOpened(res.sharedRideId, 1, res.poolStatus, res.perSeatPrice);
      } else {
        setSlotted(res.sharedRideId, 2, res.poolStatus, res.perSeatPrice);
      }
    } catch (err) {
      setRequestError(createErrorMessage(err));
    }
  }, [
    authed,
    rideType,
    pickup,
    dropoff,
    quoteKey,
    intentKeys,
    startRequest,
    setOpened,
    setSlotted,
    setRequestError,
    createErrorMessage,
  ]);

  const indicativeSeatPrice = rideType === 'shared' ? quote?.sharedEstimate?.perSeatPrice : null;
  const routeCoords = quote?.geometry?.coordinates ?? null;
  const mapCenter = pickup ?? MAP_DEFAULT_CENTER;

  const clearActiveRide = useCallback(() => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(ACTIVE_RIDE_KEY);
    intentKeys.clear();
    reset();
  }, [reset, intentKeys]);

  // Sign out drops every per-account trace: booking state, the persisted active
  // ride, the pending idempotency key; then logs out server-side.
  const handleSignOut = useCallback(() => {
    clearActiveRide();
    void signOut();
  }, [clearActiveRide, signOut]);

  const cancelActiveRide = useCallback(() => {
    if (!authed || !rideId) return;
    cancelRide(rideId)
      .then((res) => applyRideState(res.status))
      // A 409 (already terminal / not cancellable) is benign — the
      // `ride_state_changed` socket event reconciles the true state.
      .catch(() => undefined);
  }, [authed, rideId, applyRideState]);

  const rateActiveRide = useCallback(
    (stars: number, text: string) => {
      if (!authed || !rideId) return;
      // Fire-and-mark: any failure (incl. a 409 already_rated) is benign — we
      // still collapse the prompt so the rider isn't stuck re-rating.
      submitRating(rideId, stars, text).catch(() => undefined);
      markRated();
    },
    [authed, rideId, markRated],
  );

  return (
    <main
      style={{
        maxWidth: 520,
        margin: '24px auto',
        padding: 16,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>Book a ride</h1>
        <button type="button" onClick={handleSignOut} style={{ fontSize: 13 }}>
          Sign out
        </button>
      </header>
      <p style={{ fontSize: 13, color: '#525252', marginTop: 0 }}>
        Signed in as <strong>{user?.email ?? user?.phone_e164}</strong>
      </p>

      {tracking ? (
        <>
          <section style={{ marginTop: 12 }}>
            <MapPicker
              pickup={pickup}
              dropoff={dropoff}
              routeCoords={routeCoords}
              center={{ lat: mapCenter.lat, lng: mapCenter.lng }}
              onMapClick={() => undefined}
              driver={driver}
            />
          </section>
          <RideTrackingPanel
            status={rideStatus ?? 'requested'}
            searchRetry={searchRetry}
            scheduledFor={scheduledFor}
            driver={driver}
            onNewBooking={clearActiveRide}
            onCancel={cancelActiveRide}
            rated={rated}
            onRate={rateActiveRide}
            onSkipRating={markRated}
          />
        </>
      ) : (
        <>
          <section style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <AddressSearch
              label="Pickup"
              placeholder="Search pickup or tap the map"
              value={pickup}
              active={activeField === 'pickup'}
              testId="pickup-search"
              onSelect={(p: Place) => setPoint('pickup', p)}
              onFocus={() => setActiveField('pickup')}
            />
            <AddressSearch
              label="Dropoff"
              placeholder="Search dropoff or tap the map"
              value={dropoff}
              active={activeField === 'dropoff'}
              testId="dropoff-search"
              onSelect={(p: Place) => setPoint('dropoff', p)}
              onFocus={() => setActiveField('dropoff')}
            />
            <button
              type="button"
              onClick={swapPoints}
              disabled={!pickup && !dropoff}
              style={{ alignSelf: 'flex-start', fontSize: 12, padding: '4px 8px' }}
            >
              ⇅ Swap
            </button>
          </section>

          <section style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#737373', marginBottom: 4 }}>
              Quick picks (Guwahati)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {PRESET_TRIPS.map((preset: PresetTrip) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  style={{
                    fontSize: 12,
                    padding: '6px 10px',
                    borderRadius: 16,
                    border: '1px solid #d4d4d4',
                    background: '#fafafa',
                    cursor: 'pointer',
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </section>

          <section style={{ marginTop: 12 }}>
            <MapPicker
              pickup={pickup}
              dropoff={dropoff}
              routeCoords={routeCoords}
              center={{ lat: mapCenter.lat, lng: mapCenter.lng }}
              onMapClick={handleMapClick}
            />
            <div style={{ fontSize: 11, color: '#a3a3a3', marginTop: 4 }}>
              Tap the map to set your {activeField}.
            </div>
          </section>

          <section style={{ marginTop: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Ride type</label>
            <div style={{ marginTop: 6 }}>
              <RideTypeToggle
                value={rideType}
                onChange={setRideType}
                disabled={stage === 'requesting'}
              />
            </div>
          </section>

          {rideType === 'private' && (
            <section style={{ marginTop: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Pickup time</label>
              <div style={{ marginTop: 6 }}>
                <SchedulePicker
                  value={scheduledFor}
                  onChange={setScheduledFor}
                  disabled={stage === 'requesting'}
                />
              </div>
            </section>
          )}

          <section
            data-testid="quote-panel"
            style={{
              marginTop: 16,
              padding: 14,
              border: '1px solid #e5e5e5',
              borderRadius: 8,
              background: '#fff',
            }}
          >
            <div style={{ fontSize: 13, color: '#525252' }}>Quote</div>
            {!bothSet && (
              <div style={{ fontSize: 13, color: '#737373', marginTop: 4 }}>
                Set a pickup and dropoff to see your fare.
              </div>
            )}
            {stage === 'quoting' && <div>Pricing…</div>}
            {quoteError && (
              <div data-testid="quote-error" style={{ color: '#b91c1c', marginTop: 4 }}>
                {quoteError}
                <button
                  type="button"
                  data-testid="quote-retry"
                  onClick={() => setQuoteNonce((n) => n + 1)}
                  style={{ marginLeft: 8, fontSize: 12 }}
                >
                  Retry
                </button>
              </div>
            )}
            {quote && stage !== 'error' && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 20, fontWeight: 700 }} data-testid="quote-headline">
                  {rideType === 'shared' && indicativeSeatPrice
                    ? `${formatMoney(indicativeSeatPrice)} – ${formatMoney(quote.soloFare)}`
                    : formatMoney(quote.soloFare)}
                </div>
                <div style={{ fontSize: 12, color: '#525252', marginTop: 4 }}>
                  Solo fare for this route: {formatMoney(quote.soloFare)}
                  {' · '}
                  {(quote.distanceM / 1000).toFixed(1)} km
                  {' · '}
                  {Math.round(quote.durationS / 60)} min
                </div>
                {rideType === 'shared' && quote.sharedEstimate && (
                  // The seat fare is fixed when you join (stand-in policy until
                  // RCAB-E8.S9): joining a ride that already has a rider gives
                  // the shared price; starting a new one locks the solo fare.
                  <div
                    style={{ fontSize: 12, color: '#525252', marginTop: 4 }}
                    data-testid="shared-fare-note"
                  >
                    {formatMoney(quote.sharedEstimate.perSeatPrice)} if you join a ride already
                    going your way; {formatMoney(quote.soloFare)} if you start a new one. Your fare
                    is fixed when you book.
                  </div>
                )}
              </div>
            )}
          </section>

          <section style={{ marginTop: 16 }}>
            {rideType === 'shared' ? (
              <button
                type="button"
                onClick={submit}
                disabled={
                  !quote || stage === 'requesting' || stage === 'opened' || stage === 'slotted'
                }
                data-testid="submit-shared"
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: '#111',
                  color: '#fff',
                  borderRadius: 8,
                  border: 'none',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {stage === 'requesting' ? 'Requesting…' : 'Book share'}
              </button>
            ) : (
              <button
                type="button"
                onClick={submitSolo}
                disabled={!quote || stage === 'requesting'}
                data-testid="submit-private"
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  background: '#111',
                  color: '#fff',
                  borderRadius: 8,
                  border: 'none',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {stage === 'requesting' ? 'Requesting…' : scheduledFor ? 'Schedule ride' : 'Book'}
              </button>
            )}
            {requestError && (
              <div style={{ marginTop: 8, color: '#b91c1c', fontSize: 13 }}>{requestError}</div>
            )}
          </section>

          {sharedRideId && (
            <section style={{ marginTop: 16 }}>
              <div
                style={{ fontSize: 13, color: '#525252' }}
                data-testid="pool-status"
                data-pool-status={poolStatus ?? 'pending'}
                data-seat-count={seatCount}
              >
                Shared ride · {seatCount} {seatCount === 1 ? 'seat' : 'seats'} taken
                {' · '}
                {poolStatusLabel(poolStatus)}
              </div>
              {agreedFare && (
                <div style={{ fontSize: 14, marginTop: 6 }} data-testid="agreed-fare">
                  Your fare: <strong>{formatMoney(agreedFare)}</strong>{' '}
                  <span style={{ color: '#525252', fontSize: 12 }}>(fixed when you joined)</span>
                </div>
              )}
              <PoolBadge seatCount={seatCount} />
              {stage === 'solo_fallback' && (
                <SoloFallbackBanner soloFare={quote?.soloFare ?? null} />
              )}
              {/* Only once the pool is over (as for a solo ride): mid-trip it
                  dropped the rider out of the pool view. */}
              {(poolStatus === 'completed' || poolStatus === 'aborted') && (
                <button
                  type="button"
                  onClick={reset}
                  data-testid="pool-new-booking"
                  style={{ marginTop: 10, fontSize: 13, padding: '6px 10px' }}
                >
                  New booking
                </button>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default withAuth(BookPage);
