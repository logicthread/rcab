import { describe, it, expect, vi } from 'vitest';
import { RidesRealtimeListener } from './rides-realtime.listener';
import type { RideStateMachine } from './ride-state-machine.service';
import type { RidesRepository, RideRow } from './rides.repository';
import type { RealtimeBus } from '../realtime/realtime.bus';

const RIDE_ID = 'ride-1';
const DRIVER_ID = 'driver-1';
const PASSENGER_ID = 'passenger-1';

function rideRow(overrides: Partial<RideRow> = {}): RideRow {
  return {
    id: RIDE_ID,
    passengerId: PASSENGER_ID,
    originLat: 26.1,
    originLng: 91.7,
    destLat: 26.2,
    destLng: 91.8,
    fareCents: 12_000,
    status: 'accepted',
    idempotencyKey: 'idem-1',
    driverId: DRIVER_ID,
    acceptedAt: new Date(),
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function build(opts: {
  apply?: ReturnType<typeof vi.fn>;
  findById?: ReturnType<typeof vi.fn>;
} = {}) {
  const stateMachine = {
    apply: opts.apply ?? vi.fn().mockResolvedValue({ ok: true, row: rideRow({ status: 'en_route' }) }),
  };
  const ridesRepo = { findById: opts.findById ?? vi.fn().mockResolvedValue(rideRow()) };
  const bus = { joinRide: vi.fn().mockResolvedValue(undefined) };
  const listener = new RidesRealtimeListener(
    stateMachine as unknown as RideStateMachine,
    ridesRepo as unknown as RidesRepository,
    bus as unknown as RealtimeBus,
  );
  return { listener, stateMachine, ridesRepo, bus };
}

describe('RidesRealtimeListener.onDriverFirstLocation', () => {
  it('applies start_en_route for the bound driver', async () => {
    const { listener, stateMachine } = build();
    await listener.onDriverFirstLocation({ rideId: RIDE_ID, driverId: DRIVER_ID });
    expect(stateMachine.apply).toHaveBeenCalledWith(RIDE_ID, DRIVER_ID, 'start_en_route');
  });

  it('swallows an invalid_transition (ride already past accepted)', async () => {
    const apply = vi.fn().mockResolvedValue({ ok: false, reason: 'invalid_transition' });
    const { listener } = build({ apply });
    await expect(
      listener.onDriverFirstLocation({ rideId: RIDE_ID, driverId: DRIVER_ID }),
    ).resolves.toBeUndefined();
  });
});

describe('RidesRealtimeListener.onRideSubscribe', () => {
  it('joins the passenger to the ride room', async () => {
    const { listener, bus } = build();
    await listener.onRideSubscribe({ userId: PASSENGER_ID, rideId: RIDE_ID });
    expect(bus.joinRide).toHaveBeenCalledWith(PASSENGER_ID, RIDE_ID);
  });

  it('joins the bound driver to the ride room', async () => {
    const { listener, bus } = build();
    await listener.onRideSubscribe({ userId: DRIVER_ID, rideId: RIDE_ID });
    expect(bus.joinRide).toHaveBeenCalledWith(DRIVER_ID, RIDE_ID);
  });

  it('does NOT join a user who is neither passenger nor driver', async () => {
    const { listener, bus } = build();
    await listener.onRideSubscribe({ userId: 'stranger', rideId: RIDE_ID });
    expect(bus.joinRide).not.toHaveBeenCalled();
  });

  it('does nothing when the ride does not exist', async () => {
    const { listener, bus } = build({ findById: vi.fn().mockResolvedValue(null) });
    await listener.onRideSubscribe({ userId: PASSENGER_ID, rideId: 'missing' });
    expect(bus.joinRide).not.toHaveBeenCalled();
  });
});
