import { describe, it, expect, beforeEach } from 'vitest';
import { useBookingStore } from './store';
import { PRESET_TRIPS, type Place, type QuoteResponse } from './types';

function reset() {
  useBookingStore.getState().reset();
}

const PICKUP: Place = { lat: 26.175, lng: 91.751, label: 'Paltan Bazaar' };
const DROPOFF: Place = { lat: 26.167, lng: 91.7898, label: 'Zoo Road' };

function quoteFixture(): QuoteResponse {
  return {
    type: 'shared',
    distanceM: 1000,
    durationS: 600,
    soloFare: { amount: 5000, currency: 'INR' },
    quoteToken: 'quote-token-test',
    geometry: {
      type: 'LineString',
      coordinates: [
        [91.751, 26.175],
        [91.77, 26.171],
        [91.7898, 26.167],
      ],
    },
  };
}

describe('useBookingStore', () => {
  beforeEach(reset);

  it('defaults to rideType=shared, no points, active=pickup', () => {
    const s = useBookingStore.getState();
    expect(s.rideType).toBe('shared');
    expect(s.pickup).toBeNull();
    expect(s.dropoff).toBeNull();
    expect(s.activeField).toBe('pickup');
    expect(s.stage).toBe('idle');
  });

  it('setRideType clears stale quote and resets stage', () => {
    useBookingStore.setState({ quote: quoteFixture(), stage: 'quoted' });
    useBookingStore.getState().setRideType('private');
    const s = useBookingStore.getState();
    expect(s.rideType).toBe('private');
    expect(s.quote).toBeNull();
    expect(s.stage).toBe('idle');
  });

  it('setRideType is a no-op when the value is unchanged', () => {
    const before = useBookingStore.getState();
    useBookingStore.setState({ stage: 'quoted' });
    useBookingStore.getState().setRideType(before.rideType);
    expect(useBookingStore.getState().stage).toBe('quoted');
  });

  it('setPoint sets the point and advances focus to the empty endpoint', () => {
    useBookingStore.getState().setPoint('pickup', PICKUP);
    const s = useBookingStore.getState();
    expect(s.pickup).toEqual(PICKUP);
    expect(s.activeField).toBe('dropoff'); // dropoff still empty → focus moves there
  });

  it('setPoint keeps focus when the other endpoint is already set', () => {
    useBookingStore.getState().setPoint('pickup', PICKUP);
    useBookingStore.getState().setPoint('dropoff', DROPOFF);
    expect(useBookingStore.getState().activeField).toBe('dropoff');
  });

  it('setPoint clears any stale quote', () => {
    useBookingStore.setState({ quote: quoteFixture(), stage: 'quoted' });
    useBookingStore.getState().setPoint('pickup', PICKUP);
    expect(useBookingStore.getState().quote).toBeNull();
    expect(useBookingStore.getState().stage).toBe('idle');
  });

  it('applyPreset sets both endpoints and clears the quote', () => {
    useBookingStore.setState({ quote: quoteFixture(), stage: 'quoted' });
    useBookingStore.getState().applyPreset(PRESET_TRIPS[0]);
    const s = useBookingStore.getState();
    expect(s.pickup).toEqual(PRESET_TRIPS[0].pickup);
    expect(s.dropoff).toEqual(PRESET_TRIPS[0].dropoff);
    expect(s.activeField).toBe('pickup');
    expect(s.quote).toBeNull();
    expect(s.stage).toBe('idle');
  });

  it('swapPoints exchanges pickup and dropoff', () => {
    useBookingStore.getState().applyPreset(PRESET_TRIPS[0]);
    useBookingStore.getState().swapPoints();
    const s = useBookingStore.getState();
    expect(s.pickup).toEqual(PRESET_TRIPS[0].dropoff);
    expect(s.dropoff).toEqual(PRESET_TRIPS[0].pickup);
  });

  it('setOpened/setSlotted transition stage and store sharedRideId', () => {
    useBookingStore.getState().setOpened('ride-1', 1, 'open');
    expect(useBookingStore.getState().stage).toBe('opened');
    expect(useBookingStore.getState().sharedRideId).toBe('ride-1');

    useBookingStore.getState().setSlotted('ride-2', 2, 'open');
    expect(useBookingStore.getState().stage).toBe('slotted');
    expect(useBookingStore.getState().sharedRideId).toBe('ride-2');
    expect(useBookingStore.getState().seatCount).toBe(2);
  });

  it('applyPoolUpdate ignores events from a different sharedRideId', () => {
    useBookingStore.getState().setOpened('ride-1', 1, 'open');
    useBookingStore.getState().applyPoolUpdate('ride-OTHER', 2, 'open');
    const s = useBookingStore.getState();
    expect(s.seatCount).toBe(1);
    expect(s.stage).toBe('opened');
  });

  it('applyPoolUpdate updates seatCount + poolStatus for the active ride', () => {
    useBookingStore.getState().setOpened('ride-1', 1, 'open');
    useBookingStore.getState().applyPoolUpdate('ride-1', 2, 'open');
    expect(useBookingStore.getState().seatCount).toBe(2);
    expect(useBookingStore.getState().poolStatus).toBe('open');
  });

  it('applyPoolUpdate with closed_timeout + seatCount=1 flips stage to solo_fallback', () => {
    useBookingStore.getState().setOpened('ride-1', 1, 'open');
    useBookingStore.getState().applyPoolUpdate('ride-1', 1, 'closed_timeout');
    expect(useBookingStore.getState().stage).toBe('solo_fallback');
    expect(useBookingStore.getState().poolStatus).toBe('closed_timeout');
  });

  it('applyPoolUpdate with closed_full does NOT flip to solo_fallback', () => {
    useBookingStore.getState().setOpened('ride-1', 1, 'open');
    useBookingStore.getState().applyPoolUpdate('ride-1', 3, 'closed_full');
    expect(useBookingStore.getState().stage).toBe('opened');
    expect(useBookingStore.getState().seatCount).toBe(3);
    expect(useBookingStore.getState().poolStatus).toBe('closed_full');
  });

  it('reset returns the store to initial values', () => {
    useBookingStore.getState().setOpened('ride-1', 1, 'open');
    useBookingStore.getState().setRideType('private');
    useBookingStore.getState().applyPreset(PRESET_TRIPS[0]);
    useBookingStore.getState().reset();
    const s = useBookingStore.getState();
    expect(s.rideType).toBe('shared');
    expect(s.pickup).toBeNull();
    expect(s.dropoff).toBeNull();
    expect(s.sharedRideId).toBeNull();
    expect(s.stage).toBe('idle');
  });

  // ── Solo live-tracking (RCAB-E4.S7) ──────────────────────────────────────────

  it('setSoloRequested enters the tracking stage with the ride id + status', () => {
    useBookingStore.getState().setSoloRequested('ride-solo-1', 'requested');
    const s = useBookingStore.getState();
    expect(s.stage).toBe('tracking');
    expect(s.rideId).toBe('ride-solo-1');
    expect(s.rideStatus).toBe('requested');
    expect(s.driver).toBeNull();
  });

  it('applyRideState advances the tracked status', () => {
    useBookingStore.getState().setSoloRequested('ride-solo-1', 'requested');
    useBookingStore.getState().applyRideState('en_route');
    expect(useBookingStore.getState().rideStatus).toBe('en_route');
  });

  it('applyRideState falls back to requested for an unknown wire state', () => {
    useBookingStore.getState().setSoloRequested('ride-solo-1', 'accepted');
    useBookingStore.getState().applyRideState('garbage');
    expect(useBookingStore.getState().rideStatus).toBe('requested');
  });

  it('applyRideState is ignored once there is no active ride', () => {
    useBookingStore.getState().applyRideState('en_route');
    expect(useBookingStore.getState().rideStatus).toBeNull();
  });

  it('applyDriverLocation updates the marker for the active ride', () => {
    useBookingStore.getState().setSoloRequested('ride-solo-1', 'accepted');
    useBookingStore.getState().applyDriverLocation('ride-solo-1', 26.14, 91.73, 90);
    expect(useBookingStore.getState().driver).toEqual({ lat: 26.14, lng: 91.73, heading: 90 });
  });

  it('applyDriverLocation ignores a location for a different ride', () => {
    useBookingStore.getState().setSoloRequested('ride-solo-1', 'accepted');
    useBookingStore.getState().applyDriverLocation('ride-OTHER', 1, 2, 3);
    expect(useBookingStore.getState().driver).toBeNull();
  });

  it('reset clears the solo tracking slice', () => {
    useBookingStore.getState().setSoloRequested('ride-solo-1', 'accepted');
    useBookingStore.getState().applyDriverLocation('ride-solo-1', 26.14, 91.73, 90);
    useBookingStore.getState().reset();
    const s = useBookingStore.getState();
    expect(s.rideId).toBeNull();
    expect(s.rideStatus).toBeNull();
    expect(s.driver).toBeNull();
  });
});
