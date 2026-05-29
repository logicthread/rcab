'use client';

import { useCallback, useEffect, useRef } from 'react';
import { withAuth } from '../../lib/auth/with-auth';
import { useAuthStore } from '../../lib/auth/store';
import { useBookingStore } from '../../lib/booking/store';
import { PRESET_TRIPS, apiRideType, type Money, type PresetTrip } from '../../lib/booking/types';
import { BookingApiError, createSharedRide, fetchQuote } from '../../lib/booking/api';
import { connectBookingSocket } from '../../lib/booking/ws';
import { RideTypeToggle } from './ride-type-toggle';
import { PoolBadge } from './pool-badge';
import { SoloFallbackBanner } from './solo-fallback-banner';

function formatMoney(m: Money | null | undefined): string {
  if (!m) return '—';
  return `₹${(m.amount / 100).toFixed(2)}`;
}

function isError(stage: string): stage is 'error' {
  return stage === 'error';
}

function BookPage() {
  const { user, jwt, signOut } = useAuthStore();
  const {
    rideType,
    trip,
    stage,
    quote,
    quoteError,
    sharedRideId,
    seatCount,
    poolStatus,
    requestError,
    setRideType,
    setTrip,
    startQuoting,
    setQuote,
    setQuoteError,
    startRequest,
    setOpened,
    setSlotted,
    applyPoolUpdate,
    setRequestError,
    reset,
  } = useBookingStore();

  const lastQuoteKey = useRef<string>('');

  const quoteKey = `${rideType}|${trip.id}`;

  useEffect(() => {
    if (!jwt) return;
    if (lastQuoteKey.current === quoteKey) return;
    lastQuoteKey.current = quoteKey;
    let cancelled = false;
    startQuoting();
    fetchQuote(trip, apiRideType(rideType), jwt)
      .then((res) => {
        if (!cancelled) setQuote(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof BookingApiError ? err.message : 'Quote failed';
        setQuoteError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [quoteKey, jwt, rideType, trip, startQuoting, setQuote, setQuoteError]);

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

  const submit = useCallback(async () => {
    if (!jwt) return;
    if (rideType !== 'shared') return;
    startRequest();
    try {
      const res = await createSharedRide(trip, jwt);
      if (res.mode === 'opened') {
        setOpened(res.sharedRideId, 1, res.poolStatus);
      } else {
        setSlotted(res.sharedRideId, 2, res.poolStatus);
      }
    } catch (err) {
      const message = err instanceof BookingApiError ? err.message : 'Request failed';
      setRequestError(message);
    }
  }, [jwt, rideType, trip, startRequest, setOpened, setSlotted, setRequestError]);

  const indicativeSeatPrice = rideType === 'shared' ? quote?.sharedEstimate?.perSeatPrice : null;

  return (
    <main
      style={{
        maxWidth: 480,
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

      <section style={{ marginTop: 16 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>Trip</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {PRESET_TRIPS.map((preset: PresetTrip) => (
            <label key={preset.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="radio"
                name="trip"
                value={preset.id}
                checked={preset.id === trip.id}
                onChange={() => setTrip(preset)}
              />
              <span style={{ fontSize: 14 }}>{preset.label}</span>
            </label>
          ))}
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
        {stage === 'quoting' && <div>Pricing…</div>}
        {quoteError && <div style={{ color: '#b91c1c' }}>{quoteError}</div>}
        {quote && (
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
                Indicative per-seat (2-seat pool): {formatMoney(quote.sharedEstimate.perSeatPrice)}
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
            disabled={!quote || stage === 'requesting' || stage === 'opened' || stage === 'slotted'}
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
            disabled
            data-testid="submit-private-disabled"
            title="Private booking ships with E4"
            style={{
              width: '100%',
              padding: '12px 16px',
              background: '#e5e5e5',
              color: '#737373',
              borderRadius: 8,
              border: 'none',
              fontSize: 15,
              cursor: 'not-allowed',
            }}
          >
            Private booking ships with E4
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
          {stage === 'solo_fallback' && <SoloFallbackBanner soloFare={quote?.soloFare ?? null} />}
          <button
            type="button"
            onClick={reset}
            style={{ marginTop: 10, fontSize: 13, padding: '6px 10px' }}
          >
            New booking
          </button>
        </section>
      )}

      {isError(stage) && quoteError && !quote && (
        <p style={{ color: '#b91c1c', marginTop: 12 }}>{quoteError}</p>
      )}
    </main>
  );
}

export default withAuth(BookPage);
