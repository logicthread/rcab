import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RideTrackingPanel, type RideTrackingPanelProps } from './ride-tracking-panel';

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
