import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      ['pool:subscribe', { sharedRideId: 'pool-1' }, expect.any(Function)],
      ['pool:subscribe', { sharedRideId: 'pool-1' }, expect.any(Function)],
    ]);
  });

  it('subscribes immediately when already connected', () => {
    s.connected = true;
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    expect(s.emit).toHaveBeenCalledWith(
      'pool:subscribe',
      { sharedRideId: 'pool-1' },
      expect.any(Function),
    );
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
    expect(s.emit.mock.calls).toEqual([
      ['pool:subscribe', { sharedRideId: 'pool-1' }, expect.any(Function)],
    ]);
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
    expect(s.emit).toHaveBeenCalledWith('ride:subscribe', { rideId: 'r1' }, expect.any(Function));

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

describe('ride_dispatch_retry + snapshot retryUntil (RCAB-E8.S13)', () => {
  it('forwards retry events for the followed ride only', () => {
    ioMock.mockReset();
    const s = fakeSocket(true);
    ioMock.mockReturnValue(s);
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    const seen: unknown[] = [];
    conn.onDispatchRetry((p) => seen.push(p));
    conn.subscribeRide('r1');

    s.fire('ride_dispatch_retry', { rideId: 'r1', retryCount: 1, retryUntil: '2026-11-08T10:30:00.000Z' });
    s.fire('ride_dispatch_retry', { rideId: 'r-other', retryCount: 1 });
    s.fire('ride_dispatch_retry', undefined);

    expect(seen).toEqual([{ rideId: 'r1', retryCount: 1, retryUntil: '2026-11-08T10:30:00.000Z' }]);
  });

  it('close() drops retry handlers', () => {
    ioMock.mockReset();
    const s = fakeSocket(true);
    ioMock.mockReturnValue(s);
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    const seen: unknown[] = [];
    conn.onDispatchRetry((p) => seen.push(p));
    conn.subscribeRide('r1');
    conn.close();
    s.fire('ride_dispatch_retry', { rideId: 'r1', retryCount: 1 });
    expect(seen).toEqual([]);
  });

  it('a ride:snapshot passes retryUntil through; one without it adds no key', () => {
    ioMock.mockReset();
    const s = fakeSocket(true);
    ioMock.mockReturnValue(s);
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    const events: Array<Record<string, unknown>> = [];
    conn.onRideStateChanged((p) => events.push(p as unknown as Record<string, unknown>));
    conn.subscribeRide('r1');

    s.fire('ride:snapshot', { rideId: 'r1', version: 1, status: 'requested', terminal: false, retryUntil: '2026-11-08T10:30:00.000Z' });
    s.fire('ride:snapshot', { rideId: 'r1', version: 1, status: 'requested', terminal: false });
    expect(events[0].retryUntil).toBe('2026-11-08T10:30:00.000Z');
    expect('retryUntil' in events[1]).toBe(false);
  });
});

describe('subscribe ack retry on unavailable', () => {
  let s: ReturnType<typeof fakeSocket>;
  beforeEach(() => {
    vi.useFakeTimers();
    ioMock.mockReset();
    s = fakeSocket(true);
    ioMock.mockReturnValue(s);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Ack = (a: unknown) => void;
  const lastAck = (): Ack => s.emit.mock.calls[s.emit.mock.calls.length - 1][2] as Ack;
  const UNAVAILABLE = { ok: false, reason: 'unavailable' };

  it('retries pool:subscribe with 1s,2s,4s,8s backoff, 5 tries max', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    expect(s.emit).toHaveBeenCalledTimes(1);

    lastAck()(UNAVAILABLE);
    vi.advanceTimersByTime(999);
    expect(s.emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(s.emit).toHaveBeenCalledTimes(2);

    lastAck()(UNAVAILABLE);
    vi.advanceTimersByTime(2_000);
    expect(s.emit).toHaveBeenCalledTimes(3);

    lastAck()(UNAVAILABLE);
    vi.advanceTimersByTime(4_000);
    expect(s.emit).toHaveBeenCalledTimes(4);

    lastAck()(UNAVAILABLE);
    vi.advanceTimersByTime(8_000);
    expect(s.emit).toHaveBeenCalledTimes(5);

    lastAck()(UNAVAILABLE); // 5th failure: give up
    vi.advanceTimersByTime(60_000);
    expect(s.emit).toHaveBeenCalledTimes(5);
  });

  it('retries ride:subscribe too and stops once an ack succeeds', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribeRide('r1');
    lastAck()(UNAVAILABLE);
    vi.advanceTimersByTime(1_000);
    expect(s.emit).toHaveBeenCalledTimes(2);
    expect(s.emit.mock.calls[1].slice(0, 2)).toEqual(['ride:subscribe', { rideId: 'r1' }]);
    lastAck()({ ok: true });
    vi.advanceTimersByTime(60_000);
    expect(s.emit).toHaveBeenCalledTimes(2);
  });

  it.each(['forbidden', 'not_member'])('does not retry a %s refusal', (reason) => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    lastAck()({ ok: false, reason });
    vi.advanceTimersByTime(60_000);
    expect(s.emit).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the socket dropped or the followed id changed', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    lastAck()(UNAVAILABLE);
    s.connected = false;
    vi.advanceTimersByTime(1_000);
    expect(s.emit).toHaveBeenCalledTimes(1);

    s.connected = true;
    conn.subscribePool('pool-1'); // fresh subscribe (same id) restarts the series
    expect(s.emit).toHaveBeenCalledTimes(2);
    lastAck()(UNAVAILABLE);
    conn.subscribePool('pool-2'); // followed id changed: pending retry is void
    expect(s.emit).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    expect(s.emit).toHaveBeenCalledTimes(3);
  });

  it('a late ack from a superseded subscribe schedules nothing', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    const stale = lastAck();
    s.fire('connect'); // re-subscribe supersedes the first attempt
    expect(s.emit).toHaveBeenCalledTimes(2);
    stale(UNAVAILABLE);
    vi.advanceTimersByTime(60_000);
    expect(s.emit).toHaveBeenCalledTimes(2);
  });

  it('close() clears pending retry timers', () => {
    const conn = connectBookingSocket(() => Promise.resolve('t'));
    conn.subscribePool('pool-1');
    lastAck()(UNAVAILABLE);
    conn.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(s.emit).toHaveBeenCalledTimes(1);
  });
});
