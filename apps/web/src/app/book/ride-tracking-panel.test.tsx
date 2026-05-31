import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RideTrackingPanel } from './ride-tracking-panel';

const noop = () => undefined;

describe('RideTrackingPanel', () => {
  it('shows the status banner for the current lifecycle state', () => {
    render(
      <RideTrackingPanel status="en_route" driver={null} onNewBooking={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Your driver is on the way');
  });

  it('updates the banner when the status advances', () => {
    const { rerender } = render(
      <RideTrackingPanel status="arrived" driver={null} onNewBooking={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Your driver has arrived');
    rerender(
      <RideTrackingPanel status="completed" driver={null} onNewBooking={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Trip complete');
  });

  it('shows the live indicator while a driver position is flowing', () => {
    render(
      <RideTrackingPanel
        status="en_route"
        driver={{ lat: 26.1, lng: 91.7, heading: 90 }}
        onNewBooking={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('tracking-live')).toBeInTheDocument();
  });

  it('hides the live indicator once the ride is terminal', () => {
    render(
      <RideTrackingPanel
        status="completed"
        driver={{ lat: 26.1, lng: 91.7, heading: 90 }}
        onNewBooking={noop}
        onCancel={noop}
      />,
    );
    expect(screen.queryByTestId('tracking-live')).not.toBeInTheDocument();
  });

  it('invokes onNewBooking when the button is clicked', async () => {
    const onNewBooking = vi.fn();
    render(
      <RideTrackingPanel
        status="completed"
        driver={null}
        onNewBooking={onNewBooking}
        onCancel={noop}
      />,
    );
    await userEvent.click(screen.getByTestId('tracking-new-booking'));
    expect(onNewBooking).toHaveBeenCalledOnce();
  });

  it('shows the no-show banner for a no_show ride', () => {
    render(
      <RideTrackingPanel status="no_show" driver={null} onNewBooking={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Marked as no-show');
  });

  it('offers Cancel before the trip starts and invokes onCancel', async () => {
    const onCancel = vi.fn();
    render(
      <RideTrackingPanel status="en_route" driver={null} onNewBooking={noop} onCancel={onCancel} />,
    );
    await userEvent.click(screen.getByTestId('tracking-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('hides Cancel once the trip is in progress', () => {
    render(
      <RideTrackingPanel status="in_progress" driver={null} onNewBooking={noop} onCancel={noop} />,
    );
    expect(screen.queryByTestId('tracking-cancel')).not.toBeInTheDocument();
  });

  it('hides Cancel once the ride is terminal', () => {
    render(
      <RideTrackingPanel status="cancelled" driver={null} onNewBooking={noop} onCancel={noop} />,
    );
    expect(screen.queryByTestId('tracking-cancel')).not.toBeInTheDocument();
  });
});
