import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RideTrackingPanel } from './ride-tracking-panel';

describe('RideTrackingPanel', () => {
  it('shows the status banner for the current lifecycle state', () => {
    render(<RideTrackingPanel status="en_route" driver={null} onNewBooking={() => undefined} />);
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Your driver is on the way');
  });

  it('updates the banner when the status advances', () => {
    const { rerender } = render(
      <RideTrackingPanel status="arrived" driver={null} onNewBooking={() => undefined} />,
    );
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Your driver has arrived');
    rerender(<RideTrackingPanel status="completed" driver={null} onNewBooking={() => undefined} />);
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Trip complete');
  });

  it('shows the live indicator while a driver position is flowing', () => {
    render(
      <RideTrackingPanel
        status="en_route"
        driver={{ lat: 26.1, lng: 91.7, heading: 90 }}
        onNewBooking={() => undefined}
      />,
    );
    expect(screen.getByTestId('tracking-live')).toBeInTheDocument();
  });

  it('hides the live indicator once the ride is terminal', () => {
    render(
      <RideTrackingPanel
        status="completed"
        driver={{ lat: 26.1, lng: 91.7, heading: 90 }}
        onNewBooking={() => undefined}
      />,
    );
    expect(screen.queryByTestId('tracking-live')).not.toBeInTheDocument();
  });

  it('invokes onNewBooking when the button is clicked', async () => {
    const onNewBooking = vi.fn();
    render(<RideTrackingPanel status="completed" driver={null} onNewBooking={onNewBooking} />);
    await userEvent.click(screen.getByTestId('tracking-new-booking'));
    expect(onNewBooking).toHaveBeenCalledOnce();
  });
});
