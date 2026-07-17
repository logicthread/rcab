import { describe, it, expect, vi } from 'vitest';
import {
  RideStateMachine,
  RIDE_STATE_CHANGED_EVENT,
  RIDE_CANCELLED_EVENT,
} from './ride-state-machine.service';
import type { RideRow, RideTransitionResult, RideCancelResult } from './rides.repository';

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
    type: 'normal',
    scheduledFor: null,
    idempotencyKey: 'k-1',
    driverId: 'd-1',
    acceptedAt: new Date('2026-05-30T10:00:00.000Z'),
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    ...overrides,
  };
}

function build(transitionResult: RideTransitionResult, cancelResult?: RideCancelResult) {
  const repo = {
    transition: vi.fn().mockResolvedValue(transitionResult),
    cancel: vi.fn().mockResolvedValue(cancelResult ?? transitionResult),
  };
  const bus = { toRide: vi.fn() };
  const events = { emit: vi.fn() };
  const config = { get: vi.fn().mockReturnValue(undefined) };
  const redis = { hdel: vi.fn().mockResolvedValue(1) };
  const sm = new RideStateMachine(
    repo as never,
    bus as never,
    events as never,
    config as never,
    redis as never,
  );
  return { sm, repo, bus, events, config, redis };
}

describe('RideStateMachine', () => {
  const forward = [
    ['start_en_route', 'accepted', 'en_route'],
    ['mark_arrived', 'en_route', 'arrived'],
    ['start_ride', 'arrived', 'in_progress'],
    ['end_ride', 'in_progress', 'completed'],
  ] as const;

  it.each(forward)(
    '%s transitions %s → %s and broadcasts ride_state_changed',
    async (event, from, to) => {
      const { sm, repo, bus } = build({ ok: true, row: makeRow(to) });
      const res = await sm.apply('r-1', 'd-1', event);

      expect(res.ok).toBe(true);
      expect(repo.transition).toHaveBeenCalledWith('r-1', 'd-1', from, to);
      expect(bus.toRide).toHaveBeenCalledWith('r-1', RIDE_STATE_CHANGED_EVENT, {
        rideId: 'r-1',
        state: to,
        by: 'driver',
      });
    },
  );

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

  describe('cancel', () => {
    it('client cancel → repo.cancel, broadcasts cancelled by client, emits RIDE_CANCELLED_EVENT', async () => {
      const row = makeRow('cancelled', { cancelledBy: 'client' });
      const { sm, repo, bus, events } = build({ ok: true, row }, { ok: true, row });
      const res = await sm.cancel({
        rideId: 'r-1',
        actor: 'client',
        actorId: 'p-1',
        isNoShow: false,
        reason: null,
      });

      expect(res.ok).toBe(true);
      expect(repo.cancel).toHaveBeenCalledWith({
        rideId: 'r-1',
        actor: 'client',
        actorId: 'p-1',
        isNoShow: false,
        reason: null,
        noShowWaitMs: 300_000,
      });
      expect(bus.toRide).toHaveBeenCalledWith('r-1', RIDE_STATE_CHANGED_EVENT, {
        rideId: 'r-1',
        state: 'cancelled',
        by: 'client',
      });
      expect(events.emit).toHaveBeenCalledWith(RIDE_CANCELLED_EVENT, {
        rideId: 'r-1',
        driverId: 'd-1',
      });
    });

    it('driver cancel broadcasts cancelled by driver', async () => {
      const row = makeRow('cancelled', { cancelledBy: 'driver', cancelReason: 'vehicle issue' });
      const { sm, bus } = build({ ok: true, row }, { ok: true, row });
      await sm.cancel({
        rideId: 'r-1',
        actor: 'driver',
        actorId: 'd-1',
        isNoShow: false,
        reason: 'vehicle issue',
      });
      expect(bus.toRide).toHaveBeenCalledWith('r-1', RIDE_STATE_CHANGED_EVENT, {
        rideId: 'r-1',
        state: 'cancelled',
        by: 'driver',
      });
    });

    it('no-show broadcasts state no_show', async () => {
      const row = makeRow('no_show', { cancelledBy: 'driver', cancelReason: 'no_show' });
      const { sm, bus } = build({ ok: true, row }, { ok: true, row });
      await sm.cancel({
        rideId: 'r-1',
        actor: 'driver',
        actorId: 'd-1',
        isNoShow: true,
        reason: 'no_show',
      });
      expect(bus.toRide).toHaveBeenCalledWith('r-1', RIDE_STATE_CHANGED_EVENT, {
        rideId: 'r-1',
        state: 'no_show',
        by: 'driver',
      });
    });

    it('clears the bound driver current_ride_id on cancel', async () => {
      const row = makeRow('cancelled', { cancelledBy: 'client' });
      const { sm, redis } = build({ ok: true, row }, { ok: true, row });
      await sm.cancel({
        rideId: 'r-1',
        actor: 'client',
        actorId: 'p-1',
        isNoShow: false,
        reason: null,
      });
      expect(redis.hdel).toHaveBeenCalledWith('driver:state:d-1', 'current_ride_id');
    });

    it('does not touch the driver when none is bound (cancel before claim)', async () => {
      const row = makeRow('cancelled', { driverId: null, cancelledBy: 'client' });
      const { sm, redis, events } = build({ ok: true, row }, { ok: true, row });
      await sm.cancel({
        rideId: 'r-1',
        actor: 'client',
        actorId: 'p-1',
        isNoShow: false,
        reason: null,
      });
      expect(redis.hdel).not.toHaveBeenCalled();
      expect(events.emit).toHaveBeenCalledWith(RIDE_CANCELLED_EVENT, {
        rideId: 'r-1',
        driverId: null,
      });
    });

    it.each(['not_found', 'not_owner', 'invalid_transition', 'no_show_too_early'] as const)(
      'propagates %s without broadcasting or emitting',
      async (reason) => {
        const { sm, bus, events, redis } = build(
          { ok: true, row: makeRow('arrived') },
          {
            ok: false,
            reason,
          },
        );
        const res = await sm.cancel({
          rideId: 'r-1',
          actor: 'driver',
          actorId: 'd-1',
          isNoShow: reason === 'no_show_too_early',
          reason: null,
        });
        expect(res).toEqual({ ok: false, reason });
        expect(bus.toRide).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
        expect(redis.hdel).not.toHaveBeenCalled();
      },
    );
  });
});
