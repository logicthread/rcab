import { describe, it, expect, vi } from 'vitest';
import {
  TERMINAL_RIDE_STATUSES,
  outcomeForAcceptFailure,
  poolUpdatePayload,
  rideStatusVersion,
} from './realtime.protocol';
import { RealtimeSnapshotService, isUuid } from './realtime-snapshot.service';
import { buildPolicy } from '../../config/policy/policy';

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

describe('RealtimeSnapshotService.rideSnapshot retryUntil (RCAB-E8.S13)', () => {
  const RIDE = '6f1c1a8e-8f3b-4d7a-9a52-0d5d4c1e2b3a';
  const USER = '7a1c1a8e-8f3b-4d7a-9a52-0d5d4c1e2b3b';
  const FOR = new Date('2026-11-08T10:00:00.000Z');
  const baseRow = {
    id: RIDE,
    passenger_id: USER,
    driver_id: null,
    status: 'requested',
    origin_lat: 1,
    origin_lng: 2,
    dest_lat: 3,
    dest_lng: 4,
    fare_cents: 100,
    type: 'scheduled',
    scheduled_for: FOR,
    dispatch_generation: 1,
  };
  function svc(row: Record<string, unknown>, env: Record<string, unknown> = {}, withPolicy = true) {
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [{ ...baseRow, ...row }] }) };
    const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    const policy = withPolicy ? buildPolicy({ get: (k: string) => env[k] }) : undefined;
    return new RealtimeSnapshotService(db as never, { toPool: vi.fn() } as never, policy);
  }

  it('a searching scheduled ride carries scheduled_for + the policy cutoff (30 min default)', async () => {
    const snap = await svc({}).rideSnapshot(RIDE, USER);
    expect(snap?.retryUntil).toBe('2026-11-08T10:30:00.000Z');
  });

  it('honours an overridden cutoff', async () => {
    const snap = await svc({}, { SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS: '600000' }).rideSnapshot(RIDE, USER);
    expect(snap?.retryUntil).toBe('2026-11-08T10:10:00.000Z');
  });

  it('dispatching is also a searching state', async () => {
    expect((await svc({ status: 'dispatching' }).rideSnapshot(RIDE, USER))?.retryUntil).toBe(
      '2026-11-08T10:30:00.000Z',
    );
  });

  it.each([
    ['a normal ride', { type: 'normal', scheduled_for: null }],
    ['a scheduled ride not yet woken (generation 0)', { dispatch_generation: 0 }],
    ['an accepted scheduled ride', { status: 'accepted', driver_id: USER }],
    ['a no_driver scheduled ride', { status: 'no_driver' }],
    ['a cancelled scheduled ride', { status: 'cancelled' }],
  ])('is null for %s', async (_n, row) => {
    expect((await svc(row).rideSnapshot(RIDE, USER))?.retryUntil).toBeNull();
  });

  it('is null (never invented) when no policy is wired', async () => {
    expect((await svc({}, {}, false).rideSnapshot(RIDE, USER))?.retryUntil).toBeNull();
  });
});
