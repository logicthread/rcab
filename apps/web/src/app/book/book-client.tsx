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
  type PointField,
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
  snapToRoad,
  submitRating,
} from '../../lib/booking/api';
import { connectBookingSocket } from '../../lib/booking/ws';
import { createIntentKeyTracker } from '../../lib/booking/intent';
import { reverseGeocode } from '../../lib/geo/nominatim';
import { AddressSearch } from './address-search';
import { Button } from '../../components/ui/button';
import { MenuDrawer } from '../../components/menu-drawer';
import { validateSchedule } from '../../lib/booking/schedule';
import { FEATURES } from '../../config/features';
import { RideTypeToggle } from './ride-type-toggle';
import { VehiclePicker } from './vehicle-picker';
import { SchedulePicker } from './schedule-picker';
import { PoolBadge } from './pool-badge';
import { poolStatusLabel } from '../../lib/booking/pool-status';
import { SoloFallbackBanner } from './solo-fallback-banner';
import { RideTrackingPanel } from './ride-tracking-panel';

const ACTIVE_RIDE_KEY = 'rcab_active_ride';
// Tell the rider when snapping moved their point by at least this much (smaller shifts are invisible).
const SNAP_NOTICE_MIN_M = 15;
// Terminal solo statuses: the persisted active-ride marker is dropped (and a reload
// does not resume tracking) once the ride reaches any of them. `no_show` is a terminal
// state the driver can put a ride into after the wait, so it must be here too.
const TERMINAL_RIDE_STATUSES: readonly string[] = [
  'completed',
  'no_driver',
  'cancelled',
  'no_show',
];

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
    vehicle,
    setVehicle,
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

  // Every pickup / drop-off is snapped to the nearest road BEFORE it is set, so the
  // marker the rider sees, the quote token and the driver's navigation share one
  // on-road coordinate. A newer pick for the same field supersedes an older one.
  const snapSeq = useRef<Record<PointField, number>>({ pickup: 0, dropoff: 0 });
  const [snapNotes, setSnapNotes] = useState<Record<PointField, string | null>>({
    pickup: null,
    dropoff: null,
  });
  const [snapError, setSnapError] = useState<string | null>(null);

  const resolvePoint = useCallback(
    async (field: PointField, place: Place): Promise<Place | null> => {
      const seq = ++snapSeq.current[field];
      const name = field === 'pickup' ? 'Pickup' : 'Drop-off';
      try {
        const snapped = await snapToRoad(place.lat, place.lng);
        if (seq !== snapSeq.current[field]) return null;
        setSnapError(null);
        setSnapNotes((n) => ({
          ...n,
          [field]:
            snapped.distanceM >= SNAP_NOTICE_MIN_M
              ? `${name} moved ${snapped.distanceM} m to the nearest road.`
              : null,
        }));
        return { ...place, lat: snapped.lat, lng: snapped.lng };
      } catch (err) {
        if (seq !== snapSeq.current[field]) return null;
        if (err instanceof BookingApiError && err.isNoRoadNearby) {
          setSnapError(`${name}: ${err.message}`);
          return null;
        }
        // Snapping is unavailable (offline / routing down): keep the point as picked;
        // the quote step reports a routing outage itself.
        setSnapNotes((n) => ({ ...n, [field]: null }));
        return place;
      }
    },
    [],
  );

  const choosePoint = useCallback(
    async (field: PointField, place: Place) => {
      const resolved = await resolvePoint(field, place);
      if (resolved) setPoint(field, resolved);
    },
    [resolvePoint, setPoint],
  );

  const choosePreset = useCallback(
    async (preset: PresetTrip) => {
      const [pickupPoint, dropoffPoint] = await Promise.all([
        resolvePoint('pickup', preset.pickup),
        resolvePoint('dropoff', preset.dropoff),
      ]);
      if (pickupPoint && dropoffPoint) {
        applyPreset({ ...preset, pickup: pickupPoint, dropoff: dropoffPoint });
      }
    },
    [resolvePoint, applyPreset],
  );

  const swapSnapped = useCallback(() => {
    swapPoints();
    setSnapNotes((n) => ({ pickup: n.dropoff, dropoff: n.pickup }));
  }, [swapPoints]);

  // Tap the map → snap, set the active endpoint, then resolve a human label.
  const handleMapClick = useCallback(
    async (lat: number, lng: number) => {
      const field = useBookingStore.getState().activeField;
      const coordLabel = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      const snapped = await resolvePoint(field, { lat, lng, label: coordLabel });
      if (!snapped) return;
      setPoint(field, snapped);
      try {
        // Name the spot the rider actually tapped; the pin itself sits on the road.
        const label = await reverseGeocode(lat, lng);
        const current = useBookingStore.getState()[field];
        if (current && current.lat === snapped.lat && current.lng === snapped.lng) {
          setPoint(field, { lat: snapped.lat, lng: snapped.lng, label });
        }
      } catch {
        /* keep the coordinate label */
      }
    },
    [resolvePoint, setPoint],
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
    <main className="mx-auto max-w-lg px-4 pb-10 pt-5">
      <header className="flex items-center gap-2">
        <MenuDrawer account={user?.email ?? user?.phone_e164} onSignOut={handleSignOut} />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Book a ride</h1>
          <p className="truncate text-sm text-muted">
            Signed in as{' '}
            <strong className="font-semibold text-ink">{user?.email ?? user?.phone_e164}</strong>
          </p>
        </div>
      </header>

      {tracking ? (
        <>
          <section className="mt-4 overflow-hidden rounded-panel border border-line shadow-lift">
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
          {/* Once a shared ride exists the booking form is done: show the pool, not the form. */}
          {sharedRideId && (
            <section className="mt-4 overflow-hidden rounded-panel border border-line shadow-lift">
              <MapPicker
                pickup={pickup}
                dropoff={dropoff}
                routeCoords={routeCoords}
                center={{ lat: mapCenter.lat, lng: mapCenter.lng }}
                onMapClick={() => undefined}
              />
            </section>
          )}
          {!sharedRideId && (
            <>
              <section className="mt-4 flex flex-col gap-3 rounded-panel border border-line bg-surface p-4 shadow-lift">
                <AddressSearch
                  label="Pickup"
                  placeholder="Search pickup or tap the map"
                  value={pickup}
                  active={activeField === 'pickup'}
                  testId="pickup-search"
                  onSelect={(p: Place) => void choosePoint('pickup', p)}
                  onFocus={() => setActiveField('pickup')}
                />
                <AddressSearch
                  label="Dropoff"
                  placeholder="Search dropoff or tap the map"
                  value={dropoff}
                  active={activeField === 'dropoff'}
                  testId="dropoff-search"
                  onSelect={(p: Place) => void choosePoint('dropoff', p)}
                  onFocus={() => setActiveField('dropoff')}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={swapSnapped}
                  disabled={!pickup && !dropoff}
                >
                  ⇅ Swap
                </Button>
                {snapError && (
                  <p
                    role="alert"
                    data-testid="snap-error"
                    className="rounded-control bg-stop-wash px-3 py-2 text-sm font-medium text-stop"
                  >
                    {snapError}
                  </p>
                )}
                {[
                  pickup && snapNotes.pickup,
                  dropoff && snapNotes.dropoff,
                ]
                  .filter((n): n is string => Boolean(n))
                  .map((note) => (
                    <p key={note} data-testid="snap-note" className="text-sm text-muted">
                      {note}
                    </p>
                  ))}
              </section>

              <section className="mt-4">
                <div className="mb-2 text-sm font-medium text-muted">Quick picks (Guwahati)</div>
                <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
                  {PRESET_TRIPS.map((preset: PresetTrip) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => void choosePreset(preset)}
                      className="min-h-tap shrink-0 rounded-full border border-line-strong bg-surface px-4 text-sm font-medium transition-colors hover:bg-amber-wash active:bg-amber-wash"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="mt-4">
                <div className="overflow-hidden rounded-panel border border-line shadow-lift">
                  <MapPicker
                    pickup={pickup}
                    dropoff={dropoff}
                    routeCoords={routeCoords}
                    center={{ lat: mapCenter.lat, lng: mapCenter.lng }}
                    onMapClick={handleMapClick}
                  />
                </div>
                <div className="mt-1.5 text-sm text-muted">
                  Tap the map to set your {activeField}.
                </div>
              </section>

              <section className="mt-5">
                <label className="text-sm font-semibold">Choose a vehicle</label>
                <div className="mt-2">
                  <VehiclePicker
                    value={vehicle}
                    onChange={setVehicle}
                    disabled={stage === 'requesting'}
                  />
                </div>
              </section>

              {FEATURES.sharedRides && (
                <section className="mt-5">
                  <label className="text-sm font-semibold">Ride type</label>
                  <div className="mt-2">
                    <RideTypeToggle
                      value={rideType}
                      onChange={setRideType}
                      disabled={stage === 'requesting'}
                    />
                  </div>
                </section>
              )}

              {rideType === 'private' && (
                <section className="mt-5">
                  <label className="text-sm font-semibold">Pickup time</label>
                  <div className="mt-2">
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
                className="mt-5 rounded-panel border border-line bg-surface p-4 shadow-lift"
              >
                <div className="text-sm font-semibold text-muted">Quote</div>
                {!bothSet && (
                  <div className="mt-1 text-sm text-muted">
                    Set a pickup and dropoff to see your fare.
                  </div>
                )}
                {stage === 'quoting' && <div className="mt-1">Pricing…</div>}
                {quoteError && (
                  <div data-testid="quote-error" className="mt-2 font-medium text-stop">
                    {quoteError}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="ml-3"
                      data-testid="quote-retry"
                      onClick={() => setQuoteNonce((n) => n + 1)}
                    >
                      Retry
                    </Button>
                  </div>
                )}
                {quote && stage !== 'error' && (
                  <div className="mt-1">
                    <div className="text-3xl font-bold tabular-nums" data-testid="quote-headline">
                      {rideType === 'shared' && indicativeSeatPrice
                        ? `${formatMoney(indicativeSeatPrice)} – ${formatMoney(quote.soloFare)}`
                        : formatMoney(quote.soloFare)}
                    </div>
                    <div className="mt-1 text-sm text-muted">
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
                        className="mt-3 rounded-control bg-go-wash px-3 py-2 text-sm text-go"
                        data-testid="shared-fare-note"
                      >
                        {formatMoney(quote.sharedEstimate.perSeatPrice)} if you join a ride already
                        going your way; {formatMoney(quote.soloFare)} if you start a new one. Your
                        fare is fixed when you book.
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="mt-5">
                {rideType === 'shared' ? (
                  <Button
                    variant="accent"
                    size="lg"
                    block
                    onClick={submit}
                    loading={stage === 'requesting'}
                    disabled={
                      !quote || stage === 'requesting' || stage === 'opened' || stage === 'slotted'
                    }
                    data-testid="submit-shared"
                  >
                    {stage === 'requesting' ? 'Requesting…' : 'Book share'}
                  </Button>
                ) : (
                  <Button
                    variant="accent"
                    size="lg"
                    block
                    onClick={submitSolo}
                    loading={stage === 'requesting'}
                    disabled={!quote || stage === 'requesting'}
                    data-testid="submit-private"
                  >
                    {stage === 'requesting'
                      ? 'Requesting…'
                      : scheduledFor
                        ? 'Schedule ride'
                        : 'Book'}
                  </Button>
                )}
                {requestError && (
                  <div className="mt-3 rounded-control bg-stop-wash px-3 py-2 text-sm font-medium text-stop">
                    {requestError}
                  </div>
                )}
              </section>
            </>
          )}

          {sharedRideId && (
            <section className="mt-4 rounded-panel border border-line bg-surface p-4 shadow-lift">
              <div
                className="text-sm font-medium text-muted"
                data-testid="pool-status"
                data-pool-status={poolStatus ?? 'pending'}
                data-seat-count={seatCount}
              >
                Shared ride · {seatCount} {seatCount === 1 ? 'seat' : 'seats'} taken
                {' · '}
                {poolStatusLabel(poolStatus)}
              </div>
              {agreedFare && (
                <div className="mt-2" data-testid="agreed-fare">
                  Your fare:{' '}
                  <strong className="text-lg tabular-nums">{formatMoney(agreedFare)}</strong>{' '}
                  <span className="text-sm text-muted">(fixed when you joined)</span>
                </div>
              )}
              <PoolBadge seatCount={seatCount} />
              {stage === 'solo_fallback' && (
                <SoloFallbackBanner soloFare={quote?.soloFare ?? null} />
              )}
              {/* Only once the pool is over (as for a solo ride): mid-trip it
                  dropped the rider out of the pool view. */}
              {(poolStatus === 'completed' || poolStatus === 'aborted') && (
                <Button
                  variant="accent"
                  block
                  className="mt-3"
                  onClick={reset}
                  data-testid="pool-new-booking"
                >
                  New booking
                </Button>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default withAuth(BookPage);
