import { describe, it, expect, vi } from 'vitest';
import {
  TERMINAL_RIDE_STATUSES,
  outcomeForAcceptFailure,
  poolUpdatePayload,
  rideStatusVersion,
} from './realtime.protocol';
import { RealtimeSnapshotService, isUuid } from './realtime-snapshot.service';

describe('rideStatusVersion (solo ordering)', () => {
  it('is strictly increasing along the forward lifecycle', () => {
    const path = ['requested', 'accepted', 'en_route', 'arrived', 'in_progress', 'completed'];
    const v = path.map(rideStatusVersion);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1]);
  });

  it('puts every terminal status at the top rank (nothing regresses a terminal ride)', () => {
    const top = rideStatusVersion('completed');
    for (const s of TERMINAL_RIDE_STATUSES) expect(rideStatusVersion(s)).toBe(top);
    expect(top).toBeGreaterThan(rideStatusVersion('in_progress'));
  });

  it('ranks an unknown status below everything', () => {
    expect(rideStatusVersion('bogus')).toBe(0);
  });
});

describe('outcomeForAcceptFailure', () => {
  it.each([
    ['trip_taken', 'lost'],
    ['offer_expired', 'expired'],
    ['offer_stale', 'expired'],
    ['offer_revoked', 'revoked'],
    ['trip_not_claimable', 'revoked'],
    ['driver_busy', 'rejected'],
    ['itinerary_missing', 'rejected'],
    ['offer_not_found', 'rejected'],
  ])('%s → %s', (reason, outcome) => {
    expect(outcomeForAcceptFailure(reason)).toBe(outcome);
  });
});

describe('poolUpdatePayload', () => {
  const row = {
    rideId: 'p',
    stateVersion: 5,
    seatCount: 2,
    maxSeats: 3,
    poolState: 'closed_full',
    claimedByDriverId: null,
  };

  it('carries the state version and only member-visible fields', () => {
    expect(poolUpdatePayload(row)).toEqual({
      sharedRideId: 'p',
      version: 5,
      seatCount: 2,
      maxSeats: 3,
      poolStatus: 'closed_full',
      terminal: false,
      driverId: null,
    });
  });

  it.each(['aborted', 'completed'])('%s is terminal', (poolState) => {
    expect(poolUpdatePayload({ ...row, poolState }).terminal).toBe(true);
  });
});

describe('RealtimeSnapshotService (no-DB paths)', () => {
  function svc(execute = vi.fn()) {
    const bus = { toPool: vi.fn() };
    const db = { execute, transaction: vi.fn() };
    return { s: new RealtimeSnapshotService(db as never, bus as never), bus, db };
  }

  it('never touches Postgres for a malformed id (no SQL with client junk)', async () => {
    const { s, db } = svc();
    expect(await s.isPoolMember('x', 'y')).toBe(false);
    expect(await s.isRideParty('x', 'y')).toBe(false);
    expect(await s.poolSnapshot('x', 'y')).toBeNull();
    expect(await s.rideSnapshot('x', 'y')).toBeNull();
    expect(await s.driverAssignment('x')).toEqual({ driverId: 'x', assignment: null });
    expect(await s.poolUpdate('x')).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('publishPoolUpdate swallows a read failure (post-commit, best effort)', async () => {
    const { s, bus } = svc(vi.fn().mockRejectedValue(new Error('pg down')));
    await expect(
      s.publishPoolUpdate('6f1c1a8e-8f3b-4d7a-9a52-0d5d4c1e2b3a'),
    ).resolves.toBeUndefined();
    expect(bus.toPool).not.toHaveBeenCalled();
  });

  it('publishPoolUpdate broadcasts the committed row to the pool room', async () => {
    const id = '6f1c1a8e-8f3b-4d7a-9a52-0d5d4c1e2b3a';
    const { s, bus } = svc(
      vi.fn().mockResolvedValue({
        rows: [
          {
            ride_id: id,
            pool_state: 'closed_started',
            seat_count: '2',
            max_seats: 3,
            state_version: '9',
            claimed_by_driver_id: 'd-1',
            completed_at: null,
          },
        ],
      }),
    );
    await s.publishPoolUpdate(id);
    expect(bus.toPool).toHaveBeenCalledWith(id, 'pool:update', {
      sharedRideId: id,
      version: 9,
      seatCount: 2,
      maxSeats: 3,
      poolStatus: 'closed_started',
      terminal: false,
      driverId: 'd-1',
    });
  });

  it('isUuid', () => {
    expect(isUuid('6f1c1a8e-8f3b-4d7a-9a52-0d5d4c1e2b3a')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
