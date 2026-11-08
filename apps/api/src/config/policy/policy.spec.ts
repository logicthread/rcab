import { describe, expect, it } from 'vitest';
import {
  PolicyValidationError,
  buildPolicy,
  defaultPolicy,
  getPolicy,
  parseKnobValue,
  policyKnobs,
} from './policy';
import { POLICY_CATEGORIES, POLICY_RULES, POLICY_SCHEMA } from './policy.schema';

function issuesOf(fn: () => unknown): PolicyValidationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof PolicyValidationError) return err;
    throw err;
  }
  throw new Error('expected PolicyValidationError');
}

describe('policy schema', () => {
  it('every default is valid and every cross-field rule holds on the defaults', () => {
    expect(() => defaultPolicy()).not.toThrow();
  });

  it('pins the shipped defaults (behaviour must not drift silently)', () => {
    const p = defaultPolicy();
    expect(p.pricing).toMatchObject({
      fareBaseCents: 4000,
      farePerKmCents: 1500,
      farePerMinCents: 200,
      seatMultiplier2: 0.7,
      seatMultiplier3: 0.55,
      platformCommissionRate: 0.2,
      sharedQuoteSeats: 2,
      sharedFarePolicy: 'fixed_at_join',
      quoteTtlMs: 300_000,
      osrmTimeoutMs: 3000,
    });
    expect(p.dispatch).toEqual({
      k1: 5,
      k2: 10,
      r1Meters: 2000,
      r2Meters: 4000,
      offerTtlMs: 12_000,
      waveOneTimeoutMs: 30_000,
      hardFailMs: 60_000,
      candidateHeadroom: 4,
      assignmentReconcileMs: 30_000,
    });
    expect(p.scheduled).toEqual({
      minLeadMs: 15 * 60_000,
      maxLeadMs: 24 * 3_600_000,
      wakeLeadMs: 10 * 60_000,
      dispatchWindowMs: 240_000,
      dispatchWaveOneMs: 120_000,
      retryCutoffAfterPickupMs: 30 * 60_000,
      dispatchConcurrency: 5,
    });
    expect(p.matching).toEqual({
      poolTimeoutMs: 60_000,
      maxSeats: 3,
      prefilterRadiusM: 1500,
      detourBudgetM: 800,
      similarityThreshold: 0.7,
      joinPriceRetries: 3,
      similaritySaturationM: 1200,
    });
    expect(p.rides.noShowWaitMs).toBe(300_000);
    expect(p.rides.clientCancellableFrom).toEqual(['requested', 'dispatching', 'accepted', 'en_route', 'arrived']);
    expect(p.rides.driverCancellableFrom).toEqual([
      'requested',
      'dispatching',
      'accepted',
      'en_route',
      'arrived',
      'in_progress',
    ]);
    expect(p.drivers).toEqual({ autoOfflineSweepMs: 15_000, staleAfterMs: 60_000 });
    expect(p.realtime).toEqual({ locationFanoutMs: 1000, geoIndexGateMs: 3000 });
    expect(p.sessions).toEqual({
      accessTokenTtlS: 900,
      refreshTokenTtlMs: 30 * 24 * 3_600_000,
      refreshReuseGraceS: 10,
      firebaseTokenMaxAgeS: 3600,
    });
    expect(p.idempotency.pendingReclaimMs).toBe(60_000);
    expect(p.rateLimits).toEqual({ globalLimit: 1000, globalWindowMs: 60_000, authLimit: 10, authWindowMs: 60_000 });
    expect(p.outbox).toEqual({
      relayPollMs: 1000,
      relayBatchSize: 50,
      relayLeaseMs: 30_000,
      maxPublishAttempts: 10,
      jobAttempts: 5,
      jobBackoffMs: 1000,
      reconcileIntervalMs: 300_000,
      reconcileGraceMs: 15_000,
      reconcileMaxPerPass: 500,
    });
  });

  it('every knob is documented, categorised and has a unique env var', () => {
    const envs = new Set<string>();
    for (const { key, category, knob } of policyKnobs()) {
      expect(POLICY_CATEGORIES[category], key).toBeDefined();
      expect(knob.description.length, key).toBeGreaterThan(10);
      expect(knob.decision.length, key).toBeGreaterThan(5);
      expect(knob.unit.length, key).toBeGreaterThan(0);
      if (knob.env) {
        expect(envs.has(knob.env), `duplicate env ${knob.env}`).toBe(false);
        expect(knob.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
        envs.add(knob.env);
      }
    }
    expect(Object.keys(POLICY_CATEGORIES).sort()).toEqual(Object.keys(POLICY_SCHEMA).sort());
  });

  it('rule keys name real knobs', () => {
    const keys = new Set(policyKnobs().map((k) => k.key));
    for (const rule of POLICY_RULES) for (const k of rule.keys) expect(keys.has(k), k).toBe(true);
  });
});

describe('buildPolicy — reading and overrides', () => {
  it('reads string env values through a ConfigService-like reader and a plain record', () => {
    const viaReader = buildPolicy({ get: (k: string) => ({ DISPATCH_K1: '7' })[k] });
    const viaRecord = buildPolicy({ DISPATCH_K1: '7', MATCHING_DETOUR_BUDGET_M: 650.5 });
    expect(viaReader.dispatch.k1).toBe(7);
    expect(viaRecord.dispatch.k1).toBe(7);
    expect(viaRecord.matching.detourBudgetM).toBe(650.5);
  });

  it('defaults to process.env', () => {
    const before = process.env.DISPATCH_K2;
    process.env.DISPATCH_K2 = '12';
    try {
      expect(buildPolicy().dispatch.k2).toBe(12);
    } finally {
      if (before === undefined) delete process.env.DISPATCH_K2;
      else process.env.DISPATCH_K2 = before;
    }
  });

  it('scheduled retry cutoff (RCAB-E8.S13): 30 min default, env override, 0 allowed, negative/garbage rejected', () => {
    expect(buildPolicy().scheduled.retryCutoffAfterPickupMs).toBe(1_800_000);
    expect(
      buildPolicy({ SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS: '600000' }).scheduled.retryCutoffAfterPickupMs,
    ).toBe(600_000);
    expect(
      buildPolicy({ SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS: '0' }).scheduled.retryCutoffAfterPickupMs,
    ).toBe(0);
    for (const bad of ['-1', 'soon', '1.5']) {
      expect(() => buildPolicy({ SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS: bad })).toThrow(
        /SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS/,
      );
    }
  });

  it('derives the scheduled wave-1 delay from the window when unset', () => {
    expect(buildPolicy({ SCHEDULED_DISPATCH_WINDOW_MS: '60001' }).scheduled.dispatchWaveOneMs).toBe(30_000);
    expect(
      buildPolicy({ SCHEDULED_DISPATCH_WINDOW_MS: '60000', SCHEDULED_DISPATCH_WAVE_ONE_MS: '10000' }).scheduled
        .dispatchWaveOneMs,
    ).toBe(10_000);
  });

  it('applies typed overrides (still validated) on top of the source', () => {
    const p = defaultPolicy({ pricing: { fareBaseCents: 5000 }, rides: { clientCancellableFrom: ['requested'] } });
    expect(p.pricing.fareBaseCents).toBe(5000);
    expect(p.pricing.farePerKmCents).toBe(1500);
    expect(p.rides.clientCancellableFrom).toEqual(['requested']);
    expect(() => defaultPolicy({ pricing: { seatMultiplier2: 2 } })).toThrow(/SEAT_MULTIPLIER_2.*must be <= 1/);
  });

  it('returns a deeply frozen object', () => {
    const p = defaultPolicy();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.dispatch)).toBe(true);
    expect(Object.isFrozen(p.rides.clientCancellableFrom)).toBe(true);
    expect(() => {
      (p.dispatch as { k1: number }).k1 = 99;
    }).toThrow(TypeError);
  });

  it('getPolicy() memoises one frozen process policy', () => {
    expect(getPolicy()).toBe(getPolicy());
    expect(Object.isFrozen(getPolicy())).toBe(true);
  });
});

describe('buildPolicy — per-knob validation', () => {
  it.each([
    ['FARE_BASE_CENTS', '', /must not be blank/],
    ['FARE_BASE_CENTS', 'abc', /finite number/],
    ['FARE_BASE_CENTS', '-5', /must be >= 0/],
    ['FARE_BASE_CENTS', 'Infinity', /finite number/],
    ['DISPATCH_K1', '2.5', /integer/],
    ['DISPATCH_K1', '0', /must be >= 1/],
    ['DISPATCH_OFFER_TTL_MS', '999', /must be >= 1000/],
    ['SEAT_MULTIPLIER_3', '1.2', /must be <= 1/],
    ['MATCHING_SIMILARITY_THRESHOLD', '-0.1', /must be >= 0/],
    ['DRIVER_AUTO_OFFLINE_SWEEP_MS', '60000', /must be <= 59000/],
    ['SCHEDULED_DISPATCH_WINDOW_MS', '1.5', /integer/],
    ['SHARED_QUOTE_SEATS', '1', /must be >= 2/],
  ])('rejects %s=%j', (env, value, reason) => {
    const err = issuesOf(() => buildPolicy({ [env]: value }));
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0].env).toEqual([env]);
    expect(err.issues[0].reason).toMatch(reason);
  });

  it('rejects code-fixed lists from the source and bad list overrides', () => {
    expect(issuesOf(() => defaultPolicy({ rides: { driverCancellableFrom: ['completed'] as never } })).message).toMatch(
      /rides\.driverCancellableFrom: entries must be among/,
    );
    expect(issuesOf(() => defaultPolicy({ rides: { clientCancellableFrom: ['arrived', 'arrived'] } })).message).toMatch(
      /must not repeat/,
    );
    expect(issuesOf(() => defaultPolicy({ rides: { clientCancellableFrom: 'x' as never } })).message).toMatch(
      /entries must be among/,
    );
  });

  it('rejects an enum value outside the allowed set', () => {
    expect(
      issuesOf(() => defaultPolicy({ pricing: { sharedFarePolicy: 'readjust' as never } })).issues[0],
    ).toEqual({ key: 'pricing.sharedFarePolicy', env: [], reason: 'must be one of fixed_at_join' });
  });
});

describe('buildPolicy — cross-field rules', () => {
  it.each([
    [{ SCHEDULED_DISPATCH_WINDOW_MS: '1000', SCHEDULED_DISPATCH_WAVE_ONE_MS: '1001' }, /waveOneMs ≤ windowMs/],
    [{ SCHEDULED_MIN_LEAD_MS: '86400000' }, /minLeadMs < maxLeadMs/],
    [{ DISPATCH_R1_METERS: '5000' }, /r1Meters ≤ r2Meters/],
    [{ DISPATCH_WAVE_ONE_TIMEOUT_MS: '60000' }, /waveOneTimeoutMs < hardFailMs/],
    [{ SEAT_MULTIPLIER_3: '0.8' }, /seatMultiplier3 ≤ seatMultiplier2/],
    [{ SHARED_QUOTE_SEATS: '4' }, /sharedQuoteSeats ≤ maxSeats/],
    [{ DRIVER_AUTO_OFFLINE_SWEEP_MS: '7000' }, /divide 60/],
    [{ DRIVER_AUTO_OFFLINE_SWEEP_MS: '1500' }, /divide 60/],
    [{ REALTIME_GEO_INDEX_GATE_MS: '60000' }, /stale cutoff/],
    [{ ACCESS_TOKEN_TTL_S: '2592000' }, /never outlives/],
  ])('rejects %j', (env, reason) => {
    const err = issuesOf(() => buildPolicy(env));
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0].key).toBe('rule');
    expect(err.issues[0].reason).toMatch(reason);
    for (const name of Object.keys(env)) expect(err.message).toContain(name);
  });

  it('allows wave one equal to the window (unchanged inclusive bound)', () => {
    expect(
      buildPolicy({ SCHEDULED_DISPATCH_WINDOW_MS: '1000', SCHEDULED_DISPATCH_WAVE_ONE_MS: '1000' }).scheduled
        .dispatchWaveOneMs,
    ).toBe(1000);
  });
});

describe('buildPolicy — fail-closed report', () => {
  it('lists every invalid key at once and never echoes a raw value', () => {
    const secretish = 's3cr3t-value-should-not-leak';
    const err = issuesOf(() =>
      buildPolicy({
        FARE_BASE_CENTS: secretish,
        DISPATCH_K1: '0',
        SEAT_MULTIPLIER_2: '7',
        SCHEDULED_DISPATCH_WINDOW_MS: 'soon',
      }),
    );
    expect(err.issues.map((i) => i.key)).toEqual([
      'pricing.fareBaseCents',
      'pricing.seatMultiplier2',
      'dispatch.k1',
      'scheduled.dispatchWindowMs',
    ]);
    expect(err.message).toMatch(/^Invalid business policy configuration \(4 problems\):/);
    expect(err.message).toContain('pricing.fareBaseCents (FARE_BASE_CENTS): must be a finite number');
    expect(err.message).not.toContain(secretish);
    expect(err.message).not.toContain('soon');
    expect(err.name).toBe('PolicyValidationError');
  });

  it('skips cross-field rules while single knobs are broken (no cascading noise)', () => {
    const err = issuesOf(() => buildPolicy({ DISPATCH_R1_METERS: 'x', DISPATCH_R2_METERS: '1' }));
    expect(err.issues).toHaveLength(1);
    expect(err.message).toMatch(/1 problem\)/);
  });
});

describe('parseKnobValue — knob types', () => {
  const common = { env: 'X_FLAG', unit: '-', description: 'a test flag', decision: 'test' };

  it.each([
    [undefined, true],
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    [false, false],
  ])('bool %j → %j', (raw, expected) => {
    expect(parseKnobValue('t.flag', { type: 'bool', default: true, ...common }, raw)).toBe(expected);
  });

  it('rejects a non-boolean bool', () => {
    expect(() => parseKnobValue('t.flag', { type: 'bool', default: true, ...common }, 'yes')).toThrow(
      /one of true, false, 1, 0/,
    );
  });

  it('parses env-backed lists from a comma string and rejects a source value for a code-fixed list', () => {
    const list = { type: 'list' as const, default: ['a'], allowed: ['a', 'b'], ...common };
    expect(parseKnobValue('t.list', list, 'a, b')).toEqual(['a', 'b']);
    expect(() => parseKnobValue('t.list', { ...list, env: null }, 'a')).toThrow(/code-fixed/);
  });

  it('reads an env-backed enum', () => {
    const e = { type: 'enum' as const, default: 'a', allowed: ['a', 'b'], ...common };
    expect(parseKnobValue('t.e', e, 'b')).toBe('b');
    expect(() => parseKnobValue('t.e', e, '')).toThrow(/one of a, b/);
  });
});
