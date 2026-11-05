import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RidesController } from './rides.controller';
import { RideType } from './dto/create-ride.dto';
import type { RideRow, RideIdempotencyOperation } from './rides.repository';
import type {
  IdempotencyClaim,
  IdempotencyRecordRow,
  IdempotencyScope,
} from './idempotency.repository';
import type { JwtPayload } from '../../common/guards/auth.guard';
import {
  IdempotencyOperation,
  PENDING_RECLAIM_AFTER_MS,
  parseIdempotencyKey,
  requestFingerprint,
} from './idempotency';

/**
 * F07 / F15 (R05) — account-scoped, fingerprint-bound idempotency for ride
 * creation, exercised through the real controller against in-memory durable
 * stores that enforce the same (principal, operation, key) uniqueness as
 * migration 0013. There is no Redis in front: every replay is a "cold cache"
 * replay from the durable record. (Real-Postgres uniqueness is covered by
 * test/integration/rides-idempotency.int.spec.ts.)
 */

const ALICE = 'alice';
const BOB = 'bob';
const QUOTE = 'quote.tok';
const ROUTE = { originLat: 26.1445, originLng: 91.7362, destLat: 26.1758, destLng: 91.7898 };
const CLAIMS = { ...ROUTE, soloFareCents: 18500, distanceM: 10197, durationS: 796 };

/** In-memory `rides` with the composite scope constraint of migration 0013. */
class FakeRidesStore {
  private readonly byScope = new Map<string, { row: RideRow; requestFingerprint: string | null }>();

  readonly create = vi.fn(
    async (p: {
      passengerId: string;
      fareCents: number;
      idempotencyKey: string;
      idempotencyOperation?: RideIdempotencyOperation;
      requestFingerprint?: string | null;
      type?: string;
      scheduledFor?: Date | null;
      originLat: number;
      originLng: number;
      destLat: number;
      destLng: number;
    }) => {
      const op = p.idempotencyOperation ?? 'ride.create.solo';
      const k = `${p.passengerId}|${op}|${p.idempotencyKey}`;
      const hit = this.byScope.get(k);
      if (hit) return { ...hit, created: false };
      const row = rideRow({
        id: randomUUID(),
        passengerId: p.passengerId,
        fareCents: p.fareCents,
        idempotencyKey: p.idempotencyKey,
        type: p.type ?? 'normal',
        scheduledFor: p.scheduledFor ?? null,
      });
      const entry = { row, requestFingerprint: p.requestFingerprint ?? null };
      this.byScope.set(k, entry);
      return { ...entry, created: true };
    },
  );

  readonly findByIdempotencyScope = vi.fn(
    async (passengerId: string, op: string, key: string) =>
      this.byScope.get(`${passengerId}|${op}|${key}`) ?? null,
  );

  readonly findById = vi.fn(async () => null);

  rowCount(): number {
    return this.byScope.size;
  }
}

/** In-memory `idempotency_record` with its (principal, operation, key) PK. */
class FakeIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecordRow>();
  private readonly startedAt = new Map<string, number>();
  /** Test hook: pretend the pending claim for `s` was made `ageMs` ago. */
  age(s: IdempotencyScope, ageMs: number) {
    this.startedAt.set(this.k(s), Date.now() - ageMs);
  }
  private k(s: IdempotencyScope) {
    return `${s.principalId}|${s.operation}|${s.key}`;
  }

  readonly claim = vi.fn(async (s: IdempotencyScope, fp: string): Promise<IdempotencyClaim> => {
    const hit = this.records.get(this.k(s));
    if (hit) {
      const began = this.startedAt.get(this.k(s)) ?? Date.now();
      if (
        hit.state === 'pending' &&
        hit.requestFingerprint === fp &&
        Date.now() - began >= PENDING_RECLAIM_AFTER_MS
      ) {
        this.startedAt.set(this.k(s), Date.now());
        return { kind: 'reclaimed', previousAttemptAt: new Date(began) };
      }
      return { kind: 'existing', record: { ...hit } };
    }
    this.startedAt.set(this.k(s), Date.now());
    this.records.set(this.k(s), {
      requestFingerprint: fp,
      state: 'pending',
      resourceId: null,
      response: null,
    });
    return { kind: 'claimed' };
  });

  readonly complete = vi.fn(async (s: IdempotencyScope, resourceId: string, response: unknown) => {
    const hit = this.records.get(this.k(s))!;
    // Persisted as jsonb: a round-trip through JSON, like Postgres.
    this.records.set(this.k(s), {
      ...hit,
      state: 'completed',
      resourceId,
      response: JSON.parse(JSON.stringify(response)),
    });
  });

  readonly release = vi.fn(async (s: IdempotencyScope) => {
    if (this.records.get(this.k(s))?.state === 'pending') this.records.delete(this.k(s));
  });
}

function rideRow(o: Partial<RideRow>): RideRow {
  return {
    id: 'r',
    passengerId: 'p',
    ...ROUTE,
    fareCents: 0,
    status: 'requested',
    type: 'normal',
    scheduledFor: null,
    idempotencyKey: 'k',
    driverId: null,
    acceptedAt: null,
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    dispatchGeneration: 1,
    ...o,
  };
}

const membership = vi.fn();
function harness(stores?: { rides: FakeRidesStore; idem: FakeIdempotencyStore }) {
  const rides = stores?.rides ?? new FakeRidesStore();
  const idem = stores?.idem ?? new FakeIdempotencyStore();
  let poolSeq = 0;
  const matching = {
    findOrCreatePool: vi.fn(async () => ({
      mode: 'opened' as const,
      sharedRideId: `pool-${++poolSeq}`,
      poolStatus: 'open' as const,
    })),
  };
  const quoteToken = { sign: vi.fn(), verify: vi.fn().mockReturnValue(CLAIMS) };
  // R07: the dispatch/wake intent is an outbox row written by RidesRepository.create
  // in the ride's own transaction (covered by the integration specs); the controller
  // only nudges the relay after a NEW booking commits and never publishes itself.
  const relay = { kick: vi.fn() };
  const scheduled = { scheduleWake: vi.fn().mockResolvedValue({}), cancelWake: vi.fn() };
  const ctrl = new RidesController(
    matching as never,
    { quoteSeat: vi.fn() } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never, // priceMatchedSeat → null
    {} as never,
    {} as never,
    quoteToken as never,
    Object.assign(rides, { findRecentPoolMembership: membership }) as never,
    {} as never,
    { joinRide: vi.fn().mockResolvedValue(undefined) } as never,
    relay as never,
    scheduled as never,
    idem as never,
  );
  return { ctrl, rides, idem, matching, quoteToken, relay, scheduled };
}

const as = (sub: string) => ({ user: { sub, role: 'client' } as JwtPayload }) as never;
const normal = (o: object = {}) =>
  ({ type: RideType.Normal, ...ROUTE, quoteToken: QUOTE, ...o }) as never;
const shared = (o: object = {}) => ({ type: RideType.Shared, ...ROUTE, ...o }) as never;
const scheduledDto = (scheduledFor: string, o: object = {}) =>
  ({ type: RideType.Scheduled, ...ROUTE, quoteToken: QUOTE, scheduledFor, ...o }) as never;

beforeEach(() => membership.mockReset().mockResolvedValue(null));

describe('ride create idempotency — account scope (F07)', () => {
  it("another account's identical key never replays the first account's ride", async () => {
    const h = harness();
    const a = (await h.ctrl.create(as(ALICE), normal(), 'shared-key')) as { rideId: string };

    // F07 probe: Bob reuses Alice's key with an invalid quote. Before the fix
    // the global replay returned Alice's ride (id, passenger, fare, status).
    h.quoteToken.verify.mockImplementationOnce(() => {
      throw Object.assign(new Error('bad'), { name: 'JsonWebTokenError' });
    });
    await expect(
      h.ctrl.create(as(BOB), normal({ quoteToken: 'garbage' }), 'shared-key'),
    ).rejects.toMatchObject({ response: { code: 'invalid_quote' } });

    // With a valid quote, Bob gets his OWN independent ride and dispatch.
    const b = (await h.ctrl.create(as(BOB), normal(), 'shared-key')) as {
      rideId: string;
      passengerId: string;
    };
    expect(b.rideId).not.toBe(a.rideId);
    expect(b.passengerId).toBe(BOB);
    expect(h.rides.rowCount()).toBe(2);
    expect(h.relay.kick).toHaveBeenCalledTimes(2);
    expect(h.rides.findByIdempotencyScope).toHaveBeenCalledWith(
      BOB,
      'ride.create.solo',
      'shared-key',
    );
  });

  it('the same key for different operations names independent requests', async () => {
    const h = harness();
    const when = new Date(Date.now() + 2 * 3600_000).toISOString();
    const solo = (await h.ctrl.create(as(ALICE), normal(), 'k1')) as { rideId: string };
    const sched = (await h.ctrl.create(as(ALICE), scheduledDto(when), 'k1')) as { rideId: string };
    expect(sched.rideId).not.toBe(solo.rideId);
    expect(h.relay.kick).toHaveBeenCalledTimes(2);
    expect(h.scheduled.scheduleWake).not.toHaveBeenCalled();
  });

  it('same account + key + different intent → 422 idempotency_key_conflict, no mutation', async () => {
    const h = harness();
    await h.ctrl.create(as(ALICE), normal(), 'k1');
    await expect(h.ctrl.create(as(ALICE), normal({ destLat: 26.2 }), 'k1')).rejects.toMatchObject({
      status: 422,
      response: { code: 'idempotency_key_conflict' },
    });
    expect(h.rides.create).toHaveBeenCalledTimes(1);
    expect(h.relay.kick).toHaveBeenCalledTimes(1);
  });

  it('same key + same route + a re-quoted token replays the original ride (no second booking)', async () => {
    const h = harness();
    const r1 = (await h.ctrl.create(as(ALICE), normal(), 'k1')) as { rideId: string };
    // Lost response → client re-quotes → retries under the SAME key, new token
    // (even one that would no longer verify: replay is resolved first).
    h.quoteToken.verify.mockImplementation(() => {
      throw Object.assign(new Error('bad'), { name: 'JsonWebTokenError' });
    });
    const retry = (await h.ctrl.create(
      as(ALICE),
      normal({ quoteToken: 'requoted.tok' }),
      'k1',
    )) as {
      rideId: string;
    };
    expect(retry.rideId).toBe(r1.rideId);
    expect(h.rides.rowCount()).toBe(1);
    expect(h.relay.kick).toHaveBeenCalledTimes(1);
  });

  it("a concurrent loser with a different intent gets 422, not the winner's ride", async () => {
    const h = harness();
    // Simulate the race: the scope lookup misses, but the insert conflicts with
    // a row committed meanwhile by a request with another fingerprint.
    h.rides.findByIdempotencyScope.mockResolvedValueOnce(null);
    h.rides.create.mockResolvedValueOnce({
      row: rideRow({ id: 'winner', passengerId: ALICE }),
      created: false,
      requestFingerprint: 'someone-elses-intent',
    });
    await expect(h.ctrl.create(as(ALICE), normal(), 'k1')).rejects.toMatchObject({
      response: { code: 'idempotency_key_conflict' },
    });
    expect(h.relay.kick).not.toHaveBeenCalled();
  });

  it('replays from the durable record after a restart (no cache), even once the quote expired', async () => {
    const first = harness();
    const original = (await first.ctrl.create(as(ALICE), normal(), 'k1')) as { rideId: string };

    // New process: fresh controller, same durable stores, quote now expired.
    const restarted = harness({ rides: first.rides, idem: first.idem });
    restarted.quoteToken.verify.mockImplementation(() => {
      throw Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    });
    const replay = (await restarted.ctrl.create(as(ALICE), normal(), 'k1')) as { rideId: string };

    expect(replay.rideId).toBe(original.rideId);
    expect(restarted.relay.kick).not.toHaveBeenCalled();
    expect(first.rides.rowCount()).toBe(1);
  });

  it('legacy (pre-0013, null fingerprint) rows replay for their owner only', async () => {
    const h = harness();
    await h.rides.create({
      passengerId: ALICE,
      ...ROUTE,
      fareCents: 100,
      idempotencyKey: 'legacy',
      requestFingerprint: null,
    });
    const replay = (await h.ctrl.create(as(ALICE), normal(), 'legacy')) as {
      fare: { amount: number };
    };
    expect(replay.fare.amount).toBe(100);
    const bob = (await h.ctrl.create(as(BOB), normal(), 'legacy')) as { passengerId: string };
    expect(bob.passengerId).toBe(BOB);
  });

  describe('scheduled', () => {
    afterEach(() => vi.useRealTimers());

    it('a late retry recovers the committed booking even after its window has passed', async () => {
      const h = harness();
      const when = new Date(Date.now() + 20 * 60_000).toISOString(); // 20 min out
      const original = (await h.ctrl.create(as(ALICE), scheduledDto(when), 'k1')) as {
        rideId: string;
      };
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 10 * 60_000); // now only 10 min lead → out of window
      const replay = (await h.ctrl.create(as(ALICE), scheduledDto(when), 'k1')) as {
        rideId: string;
      };
      expect(replay.rideId).toBe(original.rideId);
      expect(h.relay.kick).toHaveBeenCalledTimes(1);
      expect(h.scheduled.scheduleWake).not.toHaveBeenCalled();
    });

    it('same key + same slot + a re-quoted token replays the scheduled booking', async () => {
      const h = harness();
      const when = new Date(Date.now() + 2 * 3600_000).toISOString();
      const first = (await h.ctrl.create(as(ALICE), scheduledDto(when), 'k1')) as {
        rideId: string;
      };
      const retry = (await h.ctrl.create(
        as(ALICE),
        scheduledDto(when, { quoteToken: 'requoted.tok' }),
        'k1',
      )) as { rideId: string };
      expect(retry.rideId).toBe(first.rideId);
      expect(h.relay.kick).toHaveBeenCalledTimes(1);
      expect(h.scheduled.scheduleWake).not.toHaveBeenCalled();
    });

    it('a different scheduledFor under the same key is a conflict', async () => {
      const h = harness();
      const t = Date.now();
      await h.ctrl.create(as(ALICE), scheduledDto(new Date(t + 2 * 3600_000).toISOString()), 'k1');
      await expect(
        h.ctrl.create(as(ALICE), scheduledDto(new Date(t + 3 * 3600_000).toISOString()), 'k1'),
      ).rejects.toMatchObject({ response: { code: 'idempotency_key_conflict' } });
    });
  });
});

describe('shared create idempotency (F15)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('a retried identical shared request replays the original seat — one allocation', async () => {
    const first = await h.ctrl.create(as(ALICE), shared(), 'sk');
    const retry = await h.ctrl.create(as(ALICE), shared(), 'sk');
    expect(retry).toEqual(first);
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1);
  });

  it('two accounts using the same key each get their own seat', async () => {
    const a = (await h.ctrl.create(as(ALICE), shared(), 'sk')) as { sharedRideId: string };
    const b = (await h.ctrl.create(as(BOB), shared(), 'sk')) as {
      sharedRideId: string;
      passengerId: string;
    };
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(2);
    expect(b.passengerId).toBe(BOB);
    expect(b.sharedRideId).not.toBe(a.sharedRideId);
  });

  it('same key + different route → 422 and no seat allocated', async () => {
    await h.ctrl.create(as(ALICE), shared(), 'sk');
    await expect(h.ctrl.create(as(ALICE), shared({ destLat: 26.3 }), 'sk')).rejects.toMatchObject({
      status: 422,
      response: { code: 'idempotency_key_conflict' },
    });
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1);
  });

  it('a duplicate arriving while the first is in flight gets 409, not a second seat', async () => {
    let finish!: () => void;
    h.matching.findOrCreatePool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ mode: 'opened', sharedRideId: 'pool-x', poolStatus: 'open' });
        }),
    );
    const inFlight = h.ctrl.create(as(ALICE), shared(), 'sk');
    await vi.waitFor(() => expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1));
    await expect(h.ctrl.create(as(ALICE), shared(), 'sk')).rejects.toMatchObject({
      status: 409,
      response: { code: 'idempotency_request_in_progress' },
    });
    finish();
    await expect(inFlight).resolves.toMatchObject({ sharedRideId: 'pool-x' });
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1);
  });

  it('a failed allocation releases the key so the retry can proceed', async () => {
    h.matching.findOrCreatePool.mockRejectedValueOnce(new Error('osrm down'));
    await expect(h.ctrl.create(as(ALICE), shared(), 'sk')).rejects.toThrow('osrm down');
    const retry = (await h.ctrl.create(as(ALICE), shared(), 'sk')) as { sharedRideId: string };
    expect(retry.sharedRideId).toBeDefined();
    expect(h.idem.release).toHaveBeenCalledTimes(1);
  });

  const scopeOf = (sub: string, key: string) => ({
    principalId: sub,
    operation: IdempotencyOperation.Shared,
    key,
  });

  it('a pending claim younger than the bound still 409s', async () => {
    h.idem.complete.mockRejectedValue(new Error('db blip'));
    await h.ctrl.create(as(ALICE), shared(), 'sk'); // complete() fails → stays pending
    h.idem.age(scopeOf(ALICE, 'sk'), PENDING_RECLAIM_AFTER_MS - 5_000);
    await expect(h.ctrl.create(as(ALICE), shared(), 'sk')).rejects.toMatchObject({
      status: 409,
      response: { code: 'idempotency_request_in_progress' },
    });
  });

  it('a stale pending claim is reclaimed and re-allocates when no seat was taken', async () => {
    h.idem.complete.mockRejectedValue(new Error('db blip'));
    await h.ctrl.create(as(ALICE), shared(), 'sk');
    h.idem.complete.mockReset();
    h.idem.age(scopeOf(ALICE, 'sk'), PENDING_RECLAIM_AFTER_MS + 1_000);

    const retry = (await h.ctrl.create(as(ALICE), shared(), 'sk')) as { sharedRideId: string };
    expect(membership).toHaveBeenCalledTimes(1);
    expect(retry.sharedRideId).toBe('pool-2'); // nothing held → fresh allocation
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(2);
    // …and the record is now completed, so a further retry replays it.
    await expect(h.ctrl.create(as(ALICE), shared(), 'sk')).resolves.toEqual(retry);
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(2);
  });

  it('a stale pending claim returns the seat the dead attempt already took (no second seat)', async () => {
    h.idem.complete.mockRejectedValue(new Error('db blip'));
    await h.ctrl.create(as(ALICE), shared(), 'sk'); // allocated pool-1, record stuck pending
    h.idem.complete.mockReset();
    h.idem.age(scopeOf(ALICE, 'sk'), PENDING_RECLAIM_AFTER_MS + 1_000);
    membership.mockResolvedValueOnce({
      sharedRideId: 'pool-1',
      poolState: 'open',
      opened: true,
    });

    const retry = await h.ctrl.create(as(ALICE), shared(), 'sk');
    expect(retry).toMatchObject({ sharedRideId: 'pool-1', mode: 'opened', passengerId: ALICE });
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1);
    expect(h.idem.complete).toHaveBeenCalledTimes(1);
  });

  it('a stale claim with a different fingerprint is a 422, never reclaimed', async () => {
    h.idem.complete.mockRejectedValue(new Error('db blip'));
    await h.ctrl.create(as(ALICE), shared(), 'sk');
    h.idem.age(scopeOf(ALICE, 'sk'), PENDING_RECLAIM_AFTER_MS + 1_000);
    await expect(h.ctrl.create(as(ALICE), shared({ destLat: 26.3 }), 'sk')).rejects.toMatchObject({
      response: { code: 'idempotency_key_conflict' },
    });
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1);
  });

  it('a transient complete() failure is retried and the record still completes', async () => {
    h.idem.complete.mockRejectedValueOnce(new Error('blip'));
    const first = await h.ctrl.create(as(ALICE), shared(), 'sk');
    expect(h.idem.complete).toHaveBeenCalledTimes(2);
    await expect(h.ctrl.create(as(ALICE), shared(), 'sk')).resolves.toEqual(first);
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1);
  });

  it('without a key the legacy (non-idempotent) path still works', async () => {
    await h.ctrl.create(as(ALICE), shared(), undefined);
    expect(h.idem.claim).not.toHaveBeenCalled();
    expect(h.matching.findOrCreatePool).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency helpers', () => {
  it('rejects malformed or unbounded keys', () => {
    expect(() => parseIdempotencyKey('x'.repeat(129), true)).toThrow();
    expect(() => parseIdempotencyKey('has space', true)).toThrow();
    expect(() => parseIdempotencyKey(undefined, true)).toThrow();
    expect(parseIdempotencyKey(undefined, false)).toBeUndefined();
    const uuid = randomUUID();
    expect(parseIdempotencyKey(uuid, true)).toBe(uuid);
  });

  it('normalises coordinates and instants so equivalent bodies match', () => {
    const op = IdempotencyOperation.Scheduled;
    const base = { ...ROUTE, scheduledFor: '2026-11-05T10:00:00Z' };
    expect(
      requestFingerprint(op, {
        ...base,
        originLat: 26.14450000001,
        scheduledFor: '2026-11-05T15:30:00+05:30',
      }),
    ).toBe(requestFingerprint(op, base));
    expect(requestFingerprint(op, { ...base, destLng: 91.79 })).not.toBe(
      requestFingerprint(op, base),
    );
  });

  it('the quote token is not part of the fingerprint; the operation and route are', () => {
    for (const op of [IdempotencyOperation.Solo, IdempotencyOperation.Scheduled]) {
      const dto = { ...ROUTE, scheduledFor: '2026-11-05T10:00:00Z' };
      expect(requestFingerprint(op, { ...dto, quoteToken: 'a' } as never)).toBe(
        requestFingerprint(op, { ...dto, quoteToken: 'b' } as never),
      );
    }
    expect(requestFingerprint(IdempotencyOperation.Solo, ROUTE)).not.toBe(
      requestFingerprint(IdempotencyOperation.Shared, ROUTE),
    );
  });
});
