'use client';

import { useCallback, useEffect, useRef } from 'react';
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
  createNormalRide,
  createSharedRide,
  fetchQuote,
  fetchRide,
} from '../../lib/booking/api';
import { connectBookingSocket } from '../../lib/booking/ws';
import { reverseGeocode } from '../../lib/geo/nominatim';
import { AddressSearch } from './address-search';
import { RideTypeToggle } from './ride-type-toggle';
import { PoolBadge } from './pool-badge';
import { SoloFallbackBanner } from './solo-fallback-banner';
import { RideTrackingPanel } from './ride-tracking-panel';

const ACTIVE_RIDE_KEY = 'rcab_active_ride';

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

const ROUTING_UNAVAILABLE_MSG =
  "We can't route between these points yet — try pickup and drop within the city.";

function BookPage() {
  const { user, jwt, signOut } = useAuthStore();
  const {
    rideType,
    pickup,
    dropoff,
    activeField,
    stage,
    quote,
    quoteError,
    sharedRideId,
    seatCount,
    poolStatus,
    requestError,
    rideId,
    rideStatus,
    driver,
    setRideType,
    setActiveField,
    setPoint,
    applyPreset,
    swapPoints,
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
    applyDriverLocation,
    reset,
  } = useBookingStore();

  const lastQuoteKey = useRef<string>('');
  const bothSet = pickup !== null && dropoff !== null;
  const quoteKey = bothSet
    ? `${rideType}|${pickup!.lat},${pickup!.lng}|${dropoff!.lat},${dropoff!.lng}`
    : '';

  // Quote whenever both endpoints are set and the route (or ride type) changes.
  useEffect(() => {
    if (!jwt || !pickup || !dropoff || stage === 'tracking') return;
    if (lastQuoteKey.current === quoteKey) return;
    lastQuoteKey.current = quoteKey;
    let cancelled = false;
    startQuoting();
    fetchQuote(pickup, dropoff, apiRideType(rideType), jwt)
      .then((res) => {
        if (!cancelled) setQuote(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        let message = 'Quote failed';
        if (err instanceof BookingApiError) {
          message = err.isRoutingUnavailable ? ROUTING_UNAVAILABLE_MSG : err.message;
        }
        setQuoteError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [quoteKey, jwt, pickup, dropoff, rideType, stage, startQuoting, setQuote, setQuoteError]);

  useEffect(() => {
    if (!jwt || !sharedRideId) return;
    const conn = connectBookingSocket(jwt);
    const unsub = conn.onPoolUpdate((payload) => {
      applyPoolUpdate(payload.sharedRideId, payload.seatCount, payload.poolStatus);
    });
    return () => {
      unsub();
      conn.close();
    };
  }, [jwt, sharedRideId, applyPoolUpdate]);

  // Solo live-tracking: follow the ride room for status + driver position.
  useEffect(() => {
    if (!jwt || !rideId) return;
    const conn = connectBookingSocket(jwt);
    conn.subscribeRide(rideId);
    const unsubState = conn.onRideStateChanged((p) => applyRideState(p.state));
    const unsubLoc = conn.onDriverLocation((p) =>
      applyDriverLocation(p.rideId, p.lat, p.lng, p.heading),
    );
    return () => {
      unsubState();
      unsubLoc();
      conn.close();
    };
  }, [jwt, rideId, applyRideState, applyDriverLocation]);

  // Reconnect-restore: a saved active ride (full page reload) rehydrates the
  // tracking view from GET /v1/rides/:id; terminal rides clear the marker.
  useEffect(() => {
    if (!jwt || rideId || sharedRideId) return;
    const saved =
      typeof window !== 'undefined' ? window.localStorage.getItem(ACTIVE_RIDE_KEY) : null;
    if (!saved) return;
    let cancelled = false;
    fetchRide(saved, jwt)
      .then((r) => {
        if (cancelled) return;
        if (['completed', 'no_driver', 'cancelled'].includes(r.status)) {
          window.localStorage.removeItem(ACTIVE_RIDE_KEY);
          return;
        }
        useBookingStore.setState({
          pickup: { lat: r.origin.lat, lng: r.origin.lng, label: 'Pickup' },
          dropoff: { lat: r.dropoff.lat, lng: r.dropoff.lng, label: 'Dropoff' },
          rideType: 'private',
        });
        setSoloRequested(r.rideId, r.status);
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
  }, [jwt]);

  // Stop persisting a ride once it reaches a terminal state.
  useEffect(() => {
    if (
      rideStatus &&
      ['completed', 'no_driver', 'cancelled'].includes(rideStatus) &&
      typeof window !== 'undefined'
    ) {
      window.localStorage.removeItem(ACTIVE_RIDE_KEY);
    }
  }, [rideStatus]);

  const submitSolo = useCallback(async () => {
    if (!jwt || rideType !== 'private' || !pickup || !dropoff || !quote?.quoteToken) return;
    startRequest();
    try {
      const key = crypto.randomUUID();
      const res = await createNormalRide(pickup, dropoff, quote.quoteToken, jwt, key);
      if (typeof window !== 'undefined') window.localStorage.setItem(ACTIVE_RIDE_KEY, res.rideId);
      setSoloRequested(res.rideId, res.status);
    } catch (err) {
      const message = err instanceof BookingApiError ? err.message : 'Request failed';
      setRequestError(message);
    }
  }, [jwt, rideType, pickup, dropoff, quote, startRequest, setSoloRequested, setRequestError]);

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
    if (!jwt || rideType !== 'shared' || !pickup || !dropoff) return;
    startRequest();
    try {
      const res = await createSharedRide(pickup, dropoff, jwt);
      if (res.mode === 'opened') {
        setOpened(res.sharedRideId, 1, res.poolStatus);
      } else {
        setSlotted(res.sharedRideId, 2, res.poolStatus);
      }
    } catch (err) {
      const message = err instanceof BookingApiError ? err.message : 'Request failed';
      setRequestError(message);
    }
  }, [jwt, rideType, pickup, dropoff, startRequest, setOpened, setSlotted, setRequestError]);

  const indicativeSeatPrice = rideType === 'shared' ? quote?.sharedEstimate?.perSeatPrice : null;
  const routeCoords = quote?.geometry?.coordinates ?? null;
  const mapCenter = pickup ?? MAP_DEFAULT_CENTER;
  const tracking = stage === 'tracking';

  const clearActiveRide = useCallback(() => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(ACTIVE_RIDE_KEY);
    reset();
  }, [reset]);

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
        <button type="button" onClick={signOut} style={{ fontSize: 13 }}>
          Sign out
        </button>
      </header>
      <p style={{ fontSize: 13, color: '#525252', marginTop: 0 }}>
        Signed in as <strong>{user?.phone_e164}</strong>
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
            driver={driver}
            onNewBooking={clearActiveRide}
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
              </div>
            )}
            {quote && stage !== 'error' && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {rideType === 'shared'
                    ? formatMoney(indicativeSeatPrice)
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
                  <div style={{ fontSize: 12, color: '#525252', marginTop: 4 }}>
                    Indicative per-seat (2-seat pool):{' '}
                    {formatMoney(quote.sharedEstimate.perSeatPrice)}
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
                {stage === 'requesting' ? 'Requesting…' : 'Book'}
              </button>
            )}
            {requestError && (
              <div style={{ marginTop: 8, color: '#b91c1c', fontSize: 13 }}>{requestError}</div>
            )}
          </section>

          {sharedRideId && (
            <section style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, color: '#525252' }}>
                Pool: {sharedRideId.slice(0, 8)}…{' · '}seat {seatCount}
                {' · '}
                {poolStatus ?? 'pending'}
              </div>
              <PoolBadge seatCount={seatCount} />
              {stage === 'solo_fallback' && (
                <SoloFallbackBanner soloFare={quote?.soloFare ?? null} />
              )}
              <button
                type="button"
                onClick={reset}
                style={{ marginTop: 10, fontSize: 13, padding: '6px 10px' }}
              >
                New booking
              </button>
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default withAuth(BookPage);
