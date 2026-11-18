'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { withAuth } from '../../lib/auth/with-auth';
import { fetchRideHistory } from '../../lib/booking/api';
import type { RideHistoryItem } from '../../lib/booking/types';
import { buttonStyles, Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; rides: RideHistoryItem[] };

const STATUS_LABEL: Record<string, { label: string; tone: 'go' | 'stop' | 'live' }> = {
  requested: { label: 'Finding driver', tone: 'live' },
  dispatching: { label: 'Finding driver', tone: 'live' },
  accepted: { label: 'Driver assigned', tone: 'live' },
  en_route: { label: 'Driver on the way', tone: 'live' },
  arrived: { label: 'Driver arrived', tone: 'live' },
  in_progress: { label: 'On the trip', tone: 'live' },
  completed: { label: 'Completed', tone: 'go' },
  cancelled: { label: 'Cancelled', tone: 'stop' },
  no_driver: { label: 'No driver found', tone: 'stop' },
  no_show: { label: 'No-show', tone: 'stop' },
};

const TONE: Record<'go' | 'stop' | 'live', string> = {
  go: 'bg-go-wash text-go',
  stop: 'bg-stop-wash text-stop',
  live: 'bg-amber-wash text-amber-deep',
};

function formatFare(r: RideHistoryItem): string {
  return `₹${(r.fare.amount / 100).toFixed(2)}`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const coord = (p: { lat: number; lng: number }) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

function HistoryPage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    fetchRideHistory().then(
      (rides) => !cancelled && setLoad({ status: 'ready', rides }),
      () => !cancelled && setLoad({ status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <main className="mx-auto max-w-lg px-4 pb-10 pt-5">
      <header className="flex items-center gap-2">
        <Link
          href="/book"
          aria-label="Back to booking"
          className={buttonStyles({ variant: 'ghost' }) + ' -ml-2 px-3'}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
        <h1 className="text-2xl font-bold">Ride history</h1>
      </header>

      {load.status === 'loading' && (
        <p role="status" className="mt-6 flex items-center gap-2 text-muted">
          <Spinner /> Loading your rides…
        </p>
      )}

      {load.status === 'error' && (
        <div role="alert" className="mt-6 rounded-panel border border-stop/30 bg-stop-wash p-4">
          <p className="text-stop">
            Could not load your rides. Check your connection and try again.
          </p>
          <Button variant="secondary" className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}

      {load.status === 'ready' && load.rides.length === 0 && (
        <div data-testid="history-empty" className="mt-10 text-center">
          <p className="text-lg font-semibold">No rides yet</p>
          <p className="mt-1 text-muted">Your trips will show up here once you book one.</p>
          <Link href="/book" className={buttonStyles({ variant: 'accent', size: 'lg' }) + ' mt-5'}>
            Book a ride
          </Link>
        </div>
      )}

      {load.status === 'ready' && load.rides.length > 0 && (
        <ul className="mt-5 flex flex-col gap-3" data-testid="history-list">
          {load.rides.map((r) => {
            const st = STATUS_LABEL[r.status] ?? { label: r.status, tone: 'live' as const };
            return (
              <li
                key={r.rideId}
                data-testid="history-item"
                className="rounded-panel border border-line bg-surface p-4 shadow-lift"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">
                      {formatWhen(r.scheduledFor ?? r.createdAt)}
                      {r.scheduledFor && (
                        <span className="ml-2 text-sm font-medium text-muted">Scheduled</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-sm text-muted">
                      {coord(r.origin)} → {coord(r.dropoff)}
                    </div>
                  </div>
                  <div className="text-right text-lg font-bold tabular-nums">{formatFare(r)}</div>
                </div>
                <span
                  className={clsx(
                    'mt-3 inline-block rounded-full px-2.5 py-1 text-xs font-semibold',
                    TONE[st.tone],
                  )}
                >
                  {st.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

export default withAuth(HistoryPage);
