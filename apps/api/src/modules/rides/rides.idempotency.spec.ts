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
import { IdempotencyOperation, parseIdempotencyKey, requestFingerprint } from './idempotency';

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
  private k(s: IdempotencyScope) {
    return `${s.principalId}|${s.operation}|${s.key}`;
  }

  readonly claim = vi.fn(async (s: IdempotencyScope, fp: string): Promise<IdempotencyClaim> => {
    const hit = this.records.get(this.k(s));
    if (hit) return { kind: 'existing', record: { ...hit } };
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
    ...o,
  };
}

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
  const events = { emit: vi.fn() };
  const scheduled = { scheduleWake: vi.fn().mockResolvedValue({}), cancelWake: vi.fn() };
  const ctrl = new RidesController(
    matching as never,
    { quoteSeat: vi.fn() } as never,
    { findById: vi.fn().mockResolvedValue(null) } as never, // priceMatchedSeat → null
    {} as never,
    {} as never,
    quoteToken as never,
    rides as never,
    {} as never,
    { joinRide: vi.fn().mockResolvedValue(undefined) } as never,
    events as never,
    scheduled as never,
    idem as never,
  );
  return { ctrl, rides, idem, matching, quoteToken, events, scheduled };
}

const as = (sub: string) => ({ user: { sub, role: 'client' } as JwtPayload }) as never;
const normal = (o: object = {}) =>
  ({ type: RideType.Normal, ...ROUTE, quoteToken: QUOTE, ...o }) as never;
const shared = (o: object = {}) => ({ type: RideType.Shared, ...ROUTE, ...o }) as never;
const scheduledDto = (scheduledFor: string, o: object = {}) =>
  ({ type: RideType.Scheduled, ...ROUTE, quoteToken: QUOTE, scheduledFor, ...o }) as never;

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
    expect(h.events.emit).toHaveBeenCalledTimes(2);
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
    expect(h.scheduled.scheduleWake).toHaveBeenCalledTimes(1);
  });

  it('same account + key + different intent → 422 idempotency_key_conflict, no mutation', async () => {
    const h = harness();
    await h.ctrl.create(as(ALICE), normal(), 'k1');
    await expect(h.ctrl.create(as(ALICE), normal({ destLat: 26.2 }), 'k1')).rejects.toMatchObject({
      status: 422,
      response: { code: 'idempotency_key_conflict' },
    });
    // A re-quote (new token) under the old key is also a different intent.
    await expect(
      h.ctrl.create(as(ALICE), normal({ quoteToken: 'requoted.tok' }), 'k1'),
    ).rejects.toMatchObject({ response: { code: 'idempotency_key_conflict' } });
    expect(h.rides.create).toHaveBeenCalledTimes(1);
    expect(h.events.emit).toHaveBeenCalledTimes(1);
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
    expect(h.events.emit).not.toHaveBeenCalled();
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
    expect(restarted.events.emit).not.toHaveBeenCalled();
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
      expect(h.scheduled.scheduleWake).toHaveBeenCalledTimes(1);
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
    const base = { ...ROUTE, quoteToken: QUOTE, scheduledFor: '2026-11-05T10:00:00Z' };
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

  it('shared fingerprints ignore the (unused) quote token', () => {
    const op = IdempotencyOperation.Shared;
    expect(requestFingerprint(op, { ...ROUTE, quoteToken: 'a' })).toBe(
      requestFingerprint(op, ROUTE),
    );
  });
});
