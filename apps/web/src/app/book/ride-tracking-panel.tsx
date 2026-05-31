'use client';

import type { RideStatus } from '../../lib/booking/types';
import type { DriverPosition } from '../../lib/booking/store';

const BANNER: Record<RideStatus, string> = {
  requested: 'Finding your driver…',
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

export interface RideTrackingPanelProps {
  status: RideStatus;
  driver: DriverPosition | null;
  onNewBooking: () => void;
  /** Cancel the active ride. Shown only before the trip starts (a rider cannot
   * cancel an `in_progress` trip — the server rejects it). RCAB-E4.S8. */
  onCancel: () => void;
}

/** The rider's live ride-status surface: a banner driven by `ride_state_changed`
 * plus a "live" hint while `driver_location` is flowing (RCAB-E4.S7). The map +
 * driver marker live in the page; this panel is the text/controls. */
export function RideTrackingPanel({
  status,
  driver,
  onNewBooking,
  onCancel,
}: RideTrackingPanelProps) {
  const terminal = TERMINAL.has(status);
  // A rider may bail any time before the trip starts; once `in_progress` the
  // server rejects a client cancel, so hide the control.
  const canCancel = !terminal && status !== 'in_progress';
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
        {BANNER[status]}
      </div>
      {driver && !terminal && (
        <div data-testid="tracking-live" style={{ fontSize: 12, color: '#2563eb', marginTop: 6 }}>
          ● Live · following your driver
        </div>
      )}
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
