import { describe, it, expect, vi } from 'vitest';
import { RideStateMachine, RIDE_STATE_CHANGED_EVENT } from './ride-state-machine.service';
import type { RideRow, RideTransitionResult } from './rides.repository';

function makeRow(status: string, overrides: Partial<RideRow> = {}): RideRow {
  return {
    id: 'r-1',
    passengerId: 'p-1',
    originLat: 26.1445,
    originLng: 91.7362,
    destLat: 26.1805,
    destLng: 91.75,
    fareCents: 18500,
    status,
    idempotencyKey: 'k-1',
    driverId: 'd-1',
    acceptedAt: new Date('2026-05-30T10:00:00.000Z'),
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function build(transitionResult: RideTransitionResult) {
  const repo = { transition: vi.fn().mockResolvedValue(transitionResult) };
  const bus = { toRide: vi.fn() };
  const redis = { hdel: vi.fn().mockResolvedValue(1) };
  const sm = new RideStateMachine(repo as never, bus as never, redis as never);
  return { sm, repo, bus, redis };
}

describe('RideStateMachine', () => {
  const forward = [
    ['start_en_route', 'accepted', 'en_route'],
    ['mark_arrived', 'en_route', 'arrived'],
    ['start_ride', 'arrived', 'in_progress'],
    ['end_ride', 'in_progress', 'completed'],
  ] as const;

  it.each(forward)('%s transitions %s → %s and broadcasts ride_state_changed', async (event, from, to) => {
    const { sm, repo, bus } = build({ ok: true, row: makeRow(to) });
    const res = await sm.apply('r-1', 'd-1', event);

    expect(res.ok).toBe(true);
    expect(repo.transition).toHaveBeenCalledWith('r-1', 'd-1', from, to);
    expect(bus.toRide).toHaveBeenCalledWith('r-1', RIDE_STATE_CHANGED_EVENT, {
      rideId: 'r-1',
      state: to,
      by: 'driver',
    });
  });

  it('rejects an unknown event without touching the repository', async () => {
    const { sm, repo, bus } = build({ ok: true, row: makeRow('en_route') });
    const res = await sm.apply('r-1', 'd-1', 'teleport');

    expect(res).toEqual({ ok: false, reason: 'unknown_event' });
    expect(repo.transition).not.toHaveBeenCalled();
    expect(bus.toRide).not.toHaveBeenCalled();
  });

  it('propagates not_owner and does not broadcast', async () => {
    const { sm, bus } = build({ ok: false, reason: 'not_owner' });
    const res = await sm.apply('r-1', 'intruder', 'start_en_route');

    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    expect(bus.toRide).not.toHaveBeenCalled();
  });

  it('propagates invalid_transition (out-of-order) and does not broadcast', async () => {
    const { sm, bus } = build({ ok: false, reason: 'invalid_transition' });
    const res = await sm.apply('r-1', 'd-1', 'start_ride');

    expect(res).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(bus.toRide).not.toHaveBeenCalled();
  });

  it('propagates not_found', async () => {
    const { sm } = build({ ok: false, reason: 'not_found' });
    const res = await sm.apply('ghost', 'd-1', 'start_en_route');
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('clears the driver current_ride_id on end_ride → completed', async () => {
    const { sm, redis } = build({ ok: true, row: makeRow('completed') });
    await sm.apply('r-1', 'd-1', 'end_ride');
    expect(redis.hdel).toHaveBeenCalledWith('driver:state:d-1', 'current_ride_id');
  });

  it('does not clear current_ride_id on a non-terminal transition', async () => {
    const { sm, redis } = build({ ok: true, row: makeRow('en_route') });
    await sm.apply('r-1', 'd-1', 'start_en_route');
    expect(redis.hdel).not.toHaveBeenCalled();
  });
});
