import { describe, it, expect, beforeEach } from 'vitest';
import { useBookingStore } from './store';
import { PRESET_TRIPS } from './types';

function reset() {
  useBookingStore.getState().reset();
}

describe('useBookingStore', () => {
  beforeEach(reset);

  it('defaults to rideType=shared and first preset trip', () => {
    const s = useBookingStore.getState();
    expect(s.rideType).toBe('shared');
    expect(s.trip).toEqual(PRESET_TRIPS[0]);
    expect(s.stage).toBe('idle');
  });

  it('setRideType clears stale quote and resets stage', () => {
    useBookingStore.setState({
      quote: {
        type: 'shared',
        distanceM: 1000,
        durationS: 600,
        soloFare: { amount: 5000, currency: 'INR' },
      },
      stage: 'quoted',
    });
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

  it('setTrip clears quote so a refetch happens', () => {
    useBookingStore.setState({
      quote: {
        type: 'shared',
        distanceM: 1000,
        durationS: 600,
        soloFare: { amount: 5000, currency: 'INR' },
      },
      stage: 'quoted',
    });
    useBookingStore.getState().setTrip(PRESET_TRIPS[1]);
    expect(useBookingStore.getState().quote).toBeNull();
    expect(useBookingStore.getState().stage).toBe('idle');
    expect(useBookingStore.getState().trip).toEqual(PRESET_TRIPS[1]);
  });

  it('reset returns the store to initial values', () => {
    useBookingStore.getState().setOpened('ride-1', 1, 'open');
    useBookingStore.getState().setRideType('private');
    useBookingStore.getState().reset();
    const s = useBookingStore.getState();
    expect(s.rideType).toBe('shared');
    expect(s.sharedRideId).toBeNull();
    expect(s.stage).toBe('idle');
  });
});
