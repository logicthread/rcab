import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RideTrackingPanel, searchingBanner, type RideTrackingPanelProps } from './ride-tracking-panel';

const noop = () => undefined;

/** Build the panel element with sensible defaults; override per test. */
function panel(props: Partial<RideTrackingPanelProps> = {}) {
  return (
    <RideTrackingPanel
      status="en_route"
      driver={null}
      onNewBooking={noop}
      onCancel={noop}
      rated={false}
      onRate={noop}
      onSkipRating={noop}
      {...props}
    />
  );
}

describe('RideTrackingPanel', () => {
  it('shows the status banner for the current lifecycle state', () => {
    render(panel({ status: 'en_route' }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Your driver is on the way');
  });

  it('updates the banner when the status advances', () => {
    const { rerender } = render(panel({ status: 'arrived' }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Your driver has arrived');
    rerender(panel({ status: 'completed' }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Trip complete');
  });

  it('shows the live indicator while a driver position is flowing', () => {
    render(panel({ status: 'en_route', driver: { lat: 26.1, lng: 91.7, heading: 90 } }));
    expect(screen.getByTestId('tracking-live')).toBeInTheDocument();
  });

  it('hides the live indicator once the ride is terminal', () => {
    render(panel({ status: 'completed', driver: { lat: 26.1, lng: 91.7, heading: 90 } }));
    expect(screen.queryByTestId('tracking-live')).not.toBeInTheDocument();
  });

  it('invokes onNewBooking when the button is clicked', async () => {
    const onNewBooking = vi.fn();
    render(panel({ status: 'completed', onNewBooking }));
    await userEvent.click(screen.getByTestId('tracking-new-booking'));
    expect(onNewBooking).toHaveBeenCalledOnce();
  });

  it('offers New booking only once the ride is over', () => {
    for (const status of ['requested', 'accepted', 'en_route', 'arrived', 'in_progress'] as const) {
      const { unmount } = render(panel({ status }));
      expect(screen.queryByTestId('tracking-new-booking'), status).not.toBeInTheDocument();
      unmount();
    }
    for (const status of ['completed', 'no_driver', 'cancelled', 'no_show'] as const) {
      const { unmount } = render(panel({ status }));
      expect(screen.getByTestId('tracking-new-booking')).toBeInTheDocument();
      unmount();
    }
  });

  it('shows the no-show banner for a no_show ride', () => {
    render(panel({ status: 'no_show' }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Marked as no-show');
  });

  it('offers Cancel before the trip starts and invokes onCancel', async () => {
    const onCancel = vi.fn();
    render(panel({ status: 'en_route', onCancel }));
    await userEvent.click(screen.getByTestId('tracking-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('hides Cancel once the trip is in progress', () => {
    render(panel({ status: 'in_progress' }));
    expect(screen.queryByTestId('tracking-cancel')).not.toBeInTheDocument();
  });

  it('hides Cancel once the ride is terminal', () => {
    render(panel({ status: 'cancelled' }));
    expect(screen.queryByTestId('tracking-cancel')).not.toBeInTheDocument();
  });

  // ── Rating prompt (RCAB-E4.S9) ──────────────────────────────────────────────

  it('shows the rating card on a completed ride and submits the chosen rating', async () => {
    const onRate = vi.fn();
    render(panel({ status: 'completed', onRate }));
    expect(screen.getByTestId('rating-card')).toBeInTheDocument();
    // Submit is disabled until a star is chosen.
    expect(screen.getByTestId('rating-submit')).toBeDisabled();

    await userEvent.click(screen.getByTestId('rating-star-4'));
    await userEvent.type(screen.getByTestId('rating-text'), 'great');
    await userEvent.click(screen.getByTestId('rating-submit'));

    expect(onRate).toHaveBeenCalledWith(4, 'great');
  });

  it('skips rating without submitting', async () => {
    const onSkipRating = vi.fn();
    const onRate = vi.fn();
    render(panel({ status: 'completed', onSkipRating, onRate }));
    await userEvent.click(screen.getByTestId('rating-skip'));
    expect(onSkipRating).toHaveBeenCalledOnce();
    expect(onRate).not.toHaveBeenCalled();
  });

  it('shows a thank-you instead of the card once rated', () => {
    render(panel({ status: 'completed', rated: true }));
    expect(screen.queryByTestId('rating-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('rating-done')).toBeInTheDocument();
  });

  it('does not show the rating card before the ride completes', () => {
    render(panel({ status: 'en_route' }));
    expect(screen.queryByTestId('rating-card')).not.toBeInTheDocument();
  });

  it('does not show the rating card on a cancelled ride', () => {
    render(panel({ status: 'cancelled' }));
    expect(screen.queryByTestId('rating-card')).not.toBeInTheDocument();
  });
});

describe('RideTrackingPanel scheduled searching state (RCAB-E8.S13)', () => {
  const UNTIL = '2026-11-08T10:30:00.000Z';
  const untilText = new Date(UNTIL).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  it('shows the still-looking banner with the time when the server sent the cutoff', () => {
    render(panel({ status: 'requested', searchRetry: { retryUntil: UNTIL } }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent(
      `Still looking for a driver — we'll keep trying until ${untilText}`,
    );
  });

  it('omits the time when the server did not send one (never invents a cutoff)', () => {
    render(panel({ status: 'requested', searchRetry: { retryUntil: null } }));
    expect(screen.getByTestId('tracking-status').textContent).toBe(
      "Still looking for a driver — we'll keep trying",
    );
  });

  it('omits the time for an unparseable cutoff', () => {
    expect(searchingBanner('not-a-date')).toBe("Still looking for a driver — we'll keep trying");
  });

  it('applies to the dispatching status too', () => {
    render(panel({ status: 'dispatching', searchRetry: { retryUntil: UNTIL } }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent(/Still looking for a driver/);
  });

  it('a normal searching ride (no searchRetry) keeps "Finding your driver..."', () => {
    const { rerender } = render(panel({ status: 'requested' }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Finding your driver…');
    rerender(panel({ status: 'dispatching' }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Finding your driver…');
  });

  it('offers Cancel while searching and invokes onCancel', async () => {
    const onCancel = vi.fn();
    render(panel({ status: 'requested', searchRetry: { retryUntil: UNTIL }, onCancel }));
    await userEvent.click(screen.getByTestId('tracking-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('the terminal no_driver shows the normal no-driver message even if a stale searchRetry lingers', () => {
    render(panel({ status: 'no_driver', searchRetry: { retryUntil: UNTIL } }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('No driver available — please try again');
    expect(screen.queryByTestId('tracking-cancel')).not.toBeInTheDocument();
  });

  it('once a driver is assigned the searching text is gone', () => {
    render(panel({ status: 'accepted', searchRetry: { retryUntil: UNTIL } }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Driver assigned');
  });
});

describe('RideTrackingPanel scheduled ride (RCAB-E8.S14)', () => {
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  it('before the wake it says "Scheduled for ..." instead of "Finding your driver" and keeps Cancel', () => {
    render(panel({ status: 'requested', scheduledFor: inMin(120) }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent(/^Scheduled for /);
    expect(screen.getByTestId('tracking-scheduled-hint')).toHaveTextContent(/10 minutes before pickup/);
    expect(screen.getByTestId('tracking-cancel')).toBeInTheDocument();
  });

  it('inside the wake lead (searching has started) the normal banner returns', () => {
    render(panel({ status: 'requested', scheduledFor: inMin(5) }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Finding your driver…');
    expect(screen.queryByTestId('tracking-scheduled-hint')).not.toBeInTheDocument();
  });

  it('a re-armed search keeps its own "still looking" banner', () => {
    render(panel({ status: 'requested', scheduledFor: inMin(-20), searchRetry: { retryUntil: null } }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent(/Still looking for a driver/);
  });

  it('a driver assignment overrides the scheduled banner', () => {
    render(panel({ status: 'accepted', scheduledFor: inMin(120) }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Driver assigned');
  });

  it('a normal ride (no scheduledFor) is unchanged', () => {
    render(panel({ status: 'requested' }));
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Finding your driver…');
  });
});
