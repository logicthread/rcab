'use client';

import { useEffect, useState } from 'react';
import type { RideStatus } from '../../lib/booking/types';
import { formatScheduled, isBeforeWake } from '../../lib/booking/schedule';
import type { DriverPosition } from '../../lib/booking/store';
import { WEB_POLICY } from '../../config/policy';

const BANNER: Record<RideStatus, string> = {
  requested: 'Finding your driver…',
  dispatching: 'Finding your driver…',
  accepted: 'Driver assigned — getting ready',
  en_route: 'Your driver is on the way',
  arrived: 'Your driver has arrived',
  in_progress: 'On the way to your destination',
  completed: 'Trip complete',
  no_driver: 'No driver available — please try again',
  cancelled: 'Ride cancelled',
  no_show: 'Marked as no-show',
};

const TERMINAL: ReadonlySet<RideStatus> = new Set<RideStatus>([
  'completed',
  'no_driver',
  'cancelled',
  'no_show',
]);

/**
 * "Still looking for a driver — we'll keep trying until 10:30 AM" (scheduled
 * rides whose search was re-armed). The time is shown ONLY when the server sent
 * a valid `retryUntil`; otherwise the sentence stops at "keep trying".
 */
export function searchingBanner(retryUntil: string | null): string {
  const until = retryUntil ? new Date(retryUntil) : null;
  if (!until || Number.isNaN(until.getTime())) {
    return "Still looking for a driver — we'll keep trying";
  }
  const time = until.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Still looking for a driver — we'll keep trying until ${time}`;
}

export interface RideTrackingPanelProps {
  status: RideStatus;
  /** Scheduled ride still searching after a re-arm; null/absent for every other ride. */
  searchRetry?: { retryUntil: string | null } | null;
  /** Scheduled rides: requested pickup instant (ISO). Drives the "Scheduled for ..." banner until the wake. */
  scheduledFor?: string | null;
  driver: DriverPosition | null;
  onNewBooking: () => void;
  /** Cancel the active ride. Shown only before the trip starts (a rider cannot
   * cancel an `in_progress` trip — the server rejects it). RCAB-E4.S8. */
  onCancel: () => void;
  /** True once the rider has rated (or skipped) this completed ride. RCAB-E4.S9. */
  rated: boolean;
  /** Submit a 1–5 star rating (+ optional text) for the driver. RCAB-E4.S9. */
  onRate: (stars: number, text: string) => void;
  /** Dismiss the rating prompt without rating. RCAB-E4.S9. */
  onSkipRating: () => void;
}

/** The rider's live ride-status surface: a banner driven by `ride_state_changed`
 * plus a "live" hint while `driver_location` is flowing (RCAB-E4.S7), and — once
 * the trip is `completed` — a prompt to rate the driver (RCAB-E4.S9). The map +
 * driver marker live in the page; this panel is the text/controls. */
export function RideTrackingPanel({
  status,
  searchRetry = null,
  scheduledFor = null,
  driver,
  onNewBooking,
  onCancel,
  rated,
  onRate,
  onSkipRating,
}: RideTrackingPanelProps) {
  const terminal = TERMINAL.has(status);
  // A rider may bail any time before the trip starts; once `in_progress` the
  // server rejects a client cancel, so hide the control.
  const canCancel = !terminal && status !== 'in_progress';
  const searching = searchRetry !== null && (status === 'requested' || status === 'dispatching');
  // A scheduled ride sits in `requested` until the server wakes the search (T-10 min); say so instead of
  // "Finding your driver…". Re-evaluated every 30 s so the banner flips at the wake without a socket event.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!scheduledFor) return;
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [scheduledFor]);
  const waitingForWake = status === 'requested' && !searching && isBeforeWake(scheduledFor, now);
  return (
    <section
      data-testid="tracking-panel"
      style={{
        marginTop: 16,
        padding: 14,
        border: '1px solid #e5e5e5',
        borderRadius: 8,
        background: '#fff',
      }}
    >
      <div data-testid="tracking-status" style={{ fontSize: 16, fontWeight: 700 }}>
        {searching
          ? searchingBanner(searchRetry.retryUntil)
          : waitingForWake && scheduledFor
            ? `Scheduled for ${formatScheduled(scheduledFor)}`
            : BANNER[status]}
      </div>
      {waitingForWake && (
        <div data-testid="tracking-scheduled-hint" style={{ fontSize: 12, color: '#525252', marginTop: 6 }}>
          We start finding your driver about {Math.round(WEB_POLICY.booking.scheduleWakeLeadMs / 60_000)}{' '}
          minutes before pickup. You can cancel until the trip starts.
        </div>
      )}
      {driver && !terminal && (
        <div data-testid="tracking-live" style={{ fontSize: 12, color: '#2563eb', marginTop: 6 }}>
          ● Live · following your driver
        </div>
      )}
      {/* Rate the driver once the trip completes; only `completed` opens the prompt
          (a cancelled / no-show ride never does). */}
      {status === 'completed' &&
        (rated ? (
          <div data-testid="rating-done" style={{ marginTop: 12, fontSize: 13, color: '#16a34a' }}>
            Thanks for rating!
          </div>
        ) : (
          <RatingCard onSubmit={onRate} onSkip={onSkipRating} />
        ))}
      {canCancel && (
        <button
          type="button"
          data-testid="tracking-cancel"
          onClick={onCancel}
          style={{ marginTop: 12, marginRight: 8, fontSize: 13, padding: '6px 10px' }}
        >
          Cancel ride
        </button>
      )}
      <button
        type="button"
        data-testid="tracking-new-booking"
        onClick={onNewBooking}
        style={{ marginTop: 12, fontSize: 13, padding: '6px 10px' }}
      >
        New booking
      </button>
    </section>
  );
}

/** Inline 1–5 star + optional text prompt. Submit is disabled until a star is
 * chosen; Skip dismisses without rating. Capture only — RCAB-E4.S9. */
function RatingCard({
  onSubmit,
  onSkip,
}: {
  onSubmit: (stars: number, text: string) => void;
  onSkip: () => void;
}) {
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  return (
    <div
      data-testid="rating-card"
      style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eee' }}
    >
      <div style={{ fontSize: 13, color: '#525252', marginBottom: 6 }}>Rate your driver</div>
      <div data-testid="rating-stars" style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            data-testid={`rating-star-${n}`}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            aria-pressed={n <= stars}
            onClick={() => setStars(n)}
            style={{
              fontSize: 22,
              lineHeight: 1,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: n <= stars ? '#f59e0b' : '#d4d4d4',
            }}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        data-testid="rating-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment (optional)"
        maxLength={WEB_POLICY.booking.ratingCommentMaxLength}
        rows={2}
        style={{ width: '100%', marginTop: 8, fontSize: 13, padding: 6, boxSizing: 'border-box' }}
      />
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          data-testid="rating-submit"
          disabled={stars < 1}
          onClick={() => onSubmit(stars, text)}
          style={{ marginRight: 8, fontSize: 13, padding: '6px 10px' }}
        >
          Submit rating
        </button>
        <button
          type="button"
          data-testid="rating-skip"
          onClick={onSkip}
          style={{ fontSize: 13, padding: '6px 10px' }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
