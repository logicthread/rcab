import { describe, it, expect, vi, beforeEach } from 'vitest';

const ioMock = vi.fn();
vi.mock('socket.io-client', () => ({ io: (...a: unknown[]) => ioMock(...a) }));

import { connectBookingSocket, createVersionGate, rideStatusVersion } from './ws';

/** A socket.io-client stand-in that records handlers so tests can fire server events. */
function fakeSocket(connected = false) {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const s = {
    connected,
    emit: vi.fn(),
    on: vi.fn((event: string, h: (p: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return s;
    }),
    off: vi.fn((event: string, h: (p: unknown) => void) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((x) => x !== h),
      );
      return s;
    }),
    removeAllListeners: vi.fn(() => handlers.clear()),
    disconnect: vi.fn(),
    fire(event: string, payload?: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
  return s;
}

describe('connectBookingSocket auth (F18c)', () => {
  beforeEach(() => {
    ioMock.mockReset();
    ioMock.mockReturnValue(fakeSocket());
  });

  it('supplies auth as a callback evaluated per (re)connect with a fresh token', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('tok-1').mockResolvedValueOnce('tok-2');
    connectBookingSocket(getToken);
    const opts = ioMock.mock.calls[0][1] as { auth: (cb: (d: unknown) => void) => void };
    expect(typeof opts.auth).toBe('function');

    const first = vi.fn();
    opts.auth(first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ token: 'tok-1' }));

    const second = vi.fn(); // simulated reconnect
    opts.auth(second);
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith({ token: 'tok-2' }));
  });

  it('sends an empty token (server rejects) when no token can be obtained', async () => {
    connectBookingSocket(() => Promise.resolve(null));
    const opts = ioMock.mock.calls[0][1] as { auth: (cb: (d: unknown) => void) => void };
    const cb = vi.fn();
    opts.auth(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith({ token: '' }));
  });
});

describe('createVersionGate (R09 ordering)', () => {
  it('snapshot applies when >= ; events only when strictly newer; foreign ids dropped', () => {
    const g = createVersionGate();
    expect(g.event('p1', 1)).toBe(false); // not following anything yet
    g.follow('p1');
    expect(g.event('p1', 3)).toBe(true); // event before the snapshot
    expect(g.snapshot('p1', 5)).toBe(true); // authoritative, newer
    expect(g.event('p1', 4)).toBe(false); // stale (already in the snapshot)
    expect(g.event('p1', 5)).toBe(false); // duplicate
    expect(g.snapshot('p1', 5)).toBe(true); // same-version snapshot re-applies
    expect(g.snapshot('p1', 2)).toBe(false); // an older snapshot never regresses
    expect(g.event('p1', 6)).toBe(true);
    expect(g.event('p2', 99)).toBe(false); // another aggregate
    expect(g.event('p1', undefined)).toBe(true); // unversioned legacy event
  });

  it('following a new aggregate forgets the previous version', () => {
    const g = createVersionGate();
    g.follow('a');
    g.snapshot('a', 50);
    g.follow('b');
    expect(g.event('a', 51)).toBe(false);
    expect(g.snapshot('b', 1)).toBe(true);
  });

  it('solo ranks are monotonic and terminal at the top', () => {
    expect(rideStatusVersion('accepted')).toBeGreaterThan(rideStatusVersion('requested'));
    expect(rideStatusVersion('completed')).toBe(rideStatusVersion('cancelled'));
    expect(rideStatusVersion('completed')).toBeGreaterThan(rideStatusVersion('in_progress'));
  });
});

describe('connectBookingSocket pool subscription (F10 / T30)', () => {
  let s: ReturnType<typeof fakeSocket>;
  beforeEach(() => {
    ioMock.mockReset();
    s = fakeSocket();
    ioMock.mockReturnValue(s);
  });

  it('subscribes on connect AND on every reconnect (rooms never survive)', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    expect(s.emit).not.toHaveBeenCalled(); // not connected yet
    s.fire('connect');
    s.fire('connect'); // reconnect
    expect(s.emit.mock.calls).toEqual([
      ['pool:subscribe', { sharedRideId: 'pool-1' }],
      ['pool:subscribe', { sharedRideId: 'pool-1' }],
    ]);
  });

  it('subscribes immediately when already connected', () => {
    s.connected = true;
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    expect(s.emit).toHaveBeenCalledWith('pool:subscribe', { sharedRideId: 'pool-1' });
  });

  it('applies the snapshot, then only newer updates; reconnect snapshot reconciles a missed completion', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    const seen: Array<{ poolStatus: string; seatCount: number }> = [];
    conn.onPoolUpdate((p) => seen.push({ poolStatus: p.poolStatus, seatCount: p.seatCount }));
    conn.subscribePool('pool-1');

    s.fire('pool:snapshot', {
      sharedRideId: 'pool-1',
      version: 3,
      seatCount: 1,
      poolStatus: 'open',
    });
    s.fire('pool:update', { sharedRideId: 'pool-1', version: 2, seatCount: 1, poolStatus: 'open' });
    s.fire('pool:update', {
      sharedRideId: 'pool-1',
      version: 4,
      seatCount: 2,
      poolStatus: 'closed_full',
    });
    s.fire('pool:update', {
      sharedRideId: 'pool-1',
      version: 4,
      seatCount: 2,
      poolStatus: 'closed_full',
    }); // duplicate
    s.fire('pool:update', { sharedRideId: 'other', version: 9, seatCount: 3, poolStatus: 'open' });
    // Offline gap: the pool completes; the reconnect snapshot carries it.
    s.fire('connect');
    s.fire('pool:snapshot', {
      sharedRideId: 'pool-1',
      version: 9,
      seatCount: 2,
      poolStatus: 'completed',
    });
    // A late, reordered pre-gap update must not regress the terminal state.
    s.fire('pool:update', {
      sharedRideId: 'pool-1',
      version: 5,
      seatCount: 2,
      poolStatus: 'closed_started',
    });

    expect(seen).toEqual([
      { poolStatus: 'open', seatCount: 1 },
      { poolStatus: 'closed_full', seatCount: 2 },
      { poolStatus: 'completed', seatCount: 2 },
    ]);
  });

  it('ride:completed for the followed pool asks for a fresh snapshot', () => {
    s.connected = true;
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    s.emit.mockClear();
    s.fire('ride:completed', { rideId: 'pool-1' });
    s.fire('ride:completed', { rideId: 'another' });
    expect(s.emit.mock.calls).toEqual([['pool:subscribe', { sharedRideId: 'pool-1' }]]);
  });

  it('close() detaches app handlers', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    const h = vi.fn();
    conn.onPoolUpdate(h);
    conn.subscribePool('pool-1');
    conn.close();
    s.fire('pool:snapshot', {
      sharedRideId: 'pool-1',
      version: 1,
      seatCount: 1,
      poolStatus: 'open',
    });
    expect(h).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalled();
  });
});

describe('connectBookingSocket solo ride subscription', () => {
  let s: ReturnType<typeof fakeSocket>;
  beforeEach(() => {
    ioMock.mockReset();
    s = fakeSocket();
    ioMock.mockReturnValue(s);
  });

  it('re-subscribes on reconnect; snapshot + rank-versioned events never regress', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    const states: string[] = [];
    conn.onRideStateChanged((p) => states.push(p.state));
    conn.subscribeRide('r1');
    s.fire('connect');
    expect(s.emit).toHaveBeenCalledWith('ride:subscribe', { rideId: 'r1' });

    s.fire('ride:snapshot', { rideId: 'r1', version: 3, status: 'accepted', terminal: false });
    // Legacy event without version: ranked from its state → stale, dropped.
    s.fire('ride_state_changed', { rideId: 'r1', state: 'accepted', by: 'driver' });
    s.fire('ride_state_changed', { rideId: 'r1', state: 'en_route', by: 'driver' });
    s.fire('ride_state_changed', { rideId: 'r1', state: 'completed', by: 'driver', version: 10 });
    // Reordered delivery after the terminal state.
    s.fire('ride_state_changed', { rideId: 'r1', state: 'arrived', by: 'driver' });
    s.fire('ride_state_changed', { rideId: 'r-old', state: 'cancelled', by: 'client' });

    expect(states).toEqual(['accepted', 'en_route', 'completed']);
  });
});
