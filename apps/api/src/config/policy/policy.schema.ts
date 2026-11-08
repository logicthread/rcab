/**
 * THE business policy table (RCAB-E8.S10).
 *
 * Every product/business decision point of the API — fares, dispatch radii and
 * timers, the scheduled-booking window, pool matching thresholds, ride
 * lifecycle rules, session lifetimes, rate limits, realtime cadence and the
 * outbox/reconciler loop — is declared here, ONCE, with its env var, default,
 * bounds, unit and the decision behind the default. `policy.ts` reads the
 * environment through this table at boot, validates it (fail-closed) and
 * exposes a frozen, typed `Policy` object; `docs/POLICY.md` and the policy
 * block of `infra/docker/env.example/api.env.example` are generated from it
 * (`pnpm policy:doc`, drift-checked by `pnpm policy:doc:check`).
 *
 * Changing a business rule = change its `default` (and `decision`) here, or
 * override the env var per deployment. Pure infrastructure (DB/Redis URLs,
 * secrets, ports, CORS origins) stays in `common/guards/auth-config.ts` and the
 * infra modules, NOT here.
 *
 * This file is pure data (no Nest imports) so the doc generator can load it.
 */

// ── Knob shapes ──────────────────────────────────────────────────────────────

export type KnobType = 'int' | 'number' | 'bool' | 'enum' | 'duration-ms' | 'list';

interface KnobCommon {
  /** Env var that overrides the default; `null` = code-fixed (change it here). */
  env: string | null;
  /** Unit shown in the overview (ms, s, m, paise, ratio, count, …). */
  unit: string;
  /** One line: what the knob controls. */
  description: string;
  /** Where the default came from (owner decision, spec note, story). */
  decision: string;
}

/** Default computed from already-resolved knobs (declared earlier in the table). */
export interface DerivedDefault {
  /** Human form for the overview, e.g. "⌊scheduled.dispatchWindowMs / 2⌋". */
  label: string;
  compute: (resolved: Record<string, Record<string, unknown>>) => number;
}

export interface NumericKnob extends KnobCommon {
  type: 'int' | 'number' | 'duration-ms';
  default: number | DerivedDefault;
  /** Inclusive bounds. */
  min?: number;
  max?: number;
}

export interface BoolKnob extends KnobCommon {
  type: 'bool';
  default: boolean;
}

export interface EnumKnob<V extends string = string> extends KnobCommon {
  type: 'enum';
  default: V;
  allowed: readonly V[];
}

export interface ListKnob<V extends string = string> extends KnobCommon {
  type: 'list';
  default: readonly V[];
  allowed: readonly V[];
}

export type Knob = NumericKnob | BoolKnob | EnumKnob | ListKnob;

type Spec<K> = Omit<K, 'type'>;

const int = (k: Spec<NumericKnob>): NumericKnob => ({ type: 'int', ...k });
const num = (k: Spec<NumericKnob>): NumericKnob => ({ type: 'number', ...k });
/** Whole milliseconds; `min` defaults to 0. */
const ms = (k: Spec<NumericKnob>): NumericKnob => ({ type: 'duration-ms', min: 0, ...k });
function oneOf<const V extends string>(k: Spec<EnumKnob<V>>): EnumKnob<V> {
  return { type: 'enum', ...k };
}
function listOf<const V extends string>(k: Spec<ListKnob<V>>): ListKnob<V> {
  return { type: 'list', ...k };
}

/** Live ride states (terminal states can never be cancelled from). */
const LIVE_RIDE_STATES = [
  'requested',
  'dispatching',
  'accepted',
  'en_route',
  'arrived',
  'in_progress',
] as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── The table ────────────────────────────────────────────────────────────────

export const POLICY_SCHEMA = {
  pricing: {
    fareBaseCents: num({
      env: 'FARE_BASE_CENTS', default: 4000, min: 0, unit: 'paise',
      description: 'Solo fare flag-fall (base) component.',
      decision: 'features-shared-rides fare defaults (quote, RCAB-E4.S2): ₹40 base.',
    }),
    farePerKmCents: num({
      env: 'FARE_PER_KM_CENTS', default: 1500, min: 0, unit: 'paise/km',
      description: 'Solo fare per routed kilometre.',
      decision: 'features-shared-rides fare defaults (quote, RCAB-E4.S2): ₹15/km.',
    }),
    farePerMinCents: num({
      env: 'FARE_PER_MIN_CENTS', default: 200, min: 0, unit: 'paise/min',
      description: 'Solo fare per routed minute.',
      decision: 'features-shared-rides fare defaults (quote, RCAB-E4.S2): ₹2/min.',
    }),
    seatMultiplier2: num({
      env: 'SEAT_MULTIPLIER_2', default: 0.7, min: 0.01, max: 1, unit: 'ratio',
      description: 'Per-seat price multiplier when the pool has 2 seats.',
      decision: 'features-shared-rides (RCAB-E5.S5): 2 seats → 0.70.',
    }),
    seatMultiplier3: num({
      env: 'SEAT_MULTIPLIER_3', default: 0.55, min: 0.01, max: 1, unit: 'ratio',
      description: 'Per-seat price multiplier when the pool has 3+ seats.',
      decision: 'features-shared-rides (RCAB-E5.S5): 3 seats → 0.55.',
    }),
    platformCommissionRate: num({
      env: 'PLATFORM_COMMISSION_RATE', default: 0.2, min: 0, max: 1, unit: 'ratio',
      description: 'Platform cut of the gross shared fare; the driver gets the rest.',
      decision: 'RCAB-E5.S5 driver payout: 20 % commission (code default).',
    }),
    sharedQuoteSeats: int({
      env: 'SHARED_QUOTE_SEATS', default: 2, min: 2, unit: 'seats',
      description: 'Seat count assumed when quoting a shared ride before it is matched.',
      decision: 'RCAB-E5.S5: quote the 2-seat price up front (was rides.controller SHARED_QUOTE_SEATS).',
    }),
    sharedFarePolicy: oneOf({
      env: null, default: 'fixed_at_join', allowed: ['fixed_at_join'], unit: '—',
      description: 'How a shared seat fare evolves after join (persisted on the member).',
      decision: 'RCAB-E8.S8 (F15/R10) Phase-0 stand-in; RCAB-E8.S9 replaces it with a real policy.',
    }),
    quoteTtlMs: ms({
      env: 'QUOTE_TTL_MS', default: 5 * MIN, min: 1000, unit: 'ms',
      description: 'Lifetime of a signed fare quote token before the client must re-quote.',
      decision: 'features-normal-booking: quotes expire after 5 min (was QUOTE_TTL = "5m").',
    }),
    osrmTimeoutMs: ms({
      env: 'PRICING_OSRM_TIMEOUT_MS', default: 3000, min: 1, unit: 'ms',
      description: 'Bound on one OSRM routing call made while pricing (runs inside the join txn).',
      decision: 'RCAB-E8.S8 (F15): bounded so a slow OSRM cannot stall the pool row lock.',
    }),
  },

  dispatch: {
    k1: int({
      env: 'DISPATCH_K1', default: 5, min: 1, unit: 'drivers',
      description: 'Drivers offered in wave 1 (top-K nearest within R1).',
      decision: 'features-top-k-dispatch Phase-0: K = 5.',
    }),
    k2: int({
      env: 'DISPATCH_K2', default: 10, min: 1, unit: 'drivers',
      description: 'Drivers offered in wave 2 (within R2).',
      decision: 'features-top-k-dispatch Phase-0: wave-2 K = 10.',
    }),
    r1Meters: num({
      env: 'DISPATCH_R1_METERS', default: 2000, min: 1, unit: 'm',
      description: 'Wave-1 search radius around the pickup.',
      decision: 'algo-top-k-dispatch: 2 km first ring.',
    }),
    r2Meters: num({
      env: 'DISPATCH_R2_METERS', default: 4000, min: 1, unit: 'm',
      description: 'Wave-2 (widened) search radius around the pickup.',
      decision: 'features-top-k-dispatch: max radius 4 km.',
    }),
    offerTtlMs: ms({
      env: 'DISPATCH_OFFER_TTL_MS', default: 12_000, min: 1000, unit: 'ms',
      description: 'How long one driver offer stays acceptable (sent to the driver as ttlMs).',
      decision: 'features-top-k-dispatch: per-driver offer TTL 12 s.',
    }),
    waveOneTimeoutMs: ms({
      env: 'DISPATCH_WAVE_ONE_TIMEOUT_MS', default: 30_000, min: 1, unit: 'ms',
      description: 'Normal rides: delay from wave 1 to wave 2.',
      decision: 'features-top-k-dispatch: wave 2 at +30 s; frozen by Stage-C flag F-1.',
    }),
    hardFailMs: ms({
      env: 'DISPATCH_HARD_FAIL_MS', default: 60_000, min: 1, unit: 'ms',
      description: 'Normal rides: delay from wave 1 until the ride fails with no driver.',
      decision: 'features-top-k-dispatch: hard fail after 60 s; frozen by Stage-C flag F-1.',
    }),
    candidateHeadroom: int({
      env: 'DISPATCH_CANDIDATE_HEADROOM', default: 4, min: 1, unit: 'factor',
      description: 'Geo candidates fetched per wave = K × this + already-offered (before eligibility filtering).',
      decision: 'Code default (was dispatch.service CANDIDATE_HEADROOM): 4× headroom for busy/ineligible drivers.',
    }),
    assignmentReconcileMs: ms({
      env: 'DISPATCH_ASSIGNMENT_RECONCILE_MS', default: 30_000, min: 1000, unit: 'ms',
      description: 'How often the driver current_ride_id Redis projection is rebuilt from Postgres.',
      decision: 'RCAB-E8.S8 (R06): periodic projection reconcile every 30 s.',
    }),
  },

  scheduled: {
    minLeadMs: ms({
      env: 'SCHEDULED_MIN_LEAD_MS', default: 15 * MIN, min: 0, unit: 'ms',
      description: 'Earliest bookable pickup, measured from now.',
      decision: 'RCAB-E6.S2 / features-scheduled-booking: 15 min – 24 h window.',
    }),
    maxLeadMs: ms({
      env: 'SCHEDULED_MAX_LEAD_MS', default: DAY, min: 1, unit: 'ms',
      description: 'Latest bookable pickup, measured from now.',
      decision: 'RCAB-E6.S2 / features-scheduled-booking: 15 min – 24 h window.',
    }),
    wakeLeadMs: ms({
      env: 'SCHEDULED_WAKE_LEAD_MS', default: 10 * MIN, min: 0, unit: 'ms',
      description: 'Wake a scheduled ride (start dispatch) this long before pickup (T−10).',
      decision: 'RCAB-E6.S3 / features-scheduled-booking: wake at T−10 min; kept by Stage-C F-1.',
    }),
    dispatchWindowMs: ms({
      env: 'SCHEDULED_DISPATCH_WINDOW_MS', default: 4 * MIN, min: 1, unit: 'ms',
      description: 'Scheduled rides: accept/escalation window after wake; unanswered → retried (no cap), never expired.',
      decision: 'owner 2026-11-06 (Stage-C flag F-1, RCAB-E8.S8): scheduled window 4 min.',
    }),
    dispatchWaveOneMs: ms({
      env: 'SCHEDULED_DISPATCH_WAVE_ONE_MS',
      default: {
        label: '⌊scheduled.dispatchWindowMs / 2⌋',
        compute: (p) => Math.floor((p.scheduled.dispatchWindowMs as number) / 2),
      },
      min: 1, unit: 'ms',
      description: 'Scheduled rides: delay from wave 1 to wave 2 inside the window.',
      decision: 'owner 2026-11-06 (F-1): wave 2 at half the window by default.',
    }),
    dispatchConcurrency: int({
      env: 'SCHEDULED_DISPATCH_CONCURRENCY', default: 5, min: 1, unit: 'jobs',
      description: 'Wake jobs processed in parallel by one api process.',
      decision: 'RCAB-E6.S3: modest default for the Phase-0 VPS budget.',
    }),
  },

  matching: {
    poolTimeoutMs: ms({
      env: 'MATCHING_POOL_TIMEOUT_MS', default: 60_000, min: 1, unit: 'ms',
      description: 'An open shared pool closes (timeout) this long after it was opened.',
      decision: 'features-shared-rides / algo-shared-ride-matching: pool open 60 s.',
    }),
    maxSeats: int({
      env: 'MATCHING_MAX_SEATS', default: 3, min: 1, unit: 'seats',
      description: 'Seats per shared pool.',
      decision: 'algo-shared-ride-matching open-pool default: max_seats = 3.',
    }),
    prefilterRadiusM: num({
      env: 'MATCHING_PREFILTER_RADIUS_M', default: 1500, min: 1, unit: 'm',
      description: 'Spatial pre-filter: pool origin AND destination centroids within this distance.',
      decision: 'algo-shared-ride-matching tunables: 1500 m cast-net (was an SQL literal).',
    }),
    detourBudgetM: num({
      env: 'MATCHING_DETOUR_BUDGET_M', default: 800, min: 0, unit: 'm',
      description: 'Max origin / destination detour for a rider to fit a pool.',
      decision: 'algo-shared-ride-matching: 800 m, walking-acceptable on either end.',
    }),
    similarityThreshold: num({
      env: 'MATCHING_SIMILARITY_THRESHOLD', default: 0.7, min: 0, max: 1, unit: 'score',
      description: 'Minimum route-similarity score to join a pool.',
      decision: 'algo-shared-ride-matching: 0.7 separates same corridor from vaguely parallel.',
    }),
    similaritySaturationM: num({
      env: 'ROUTE_SIMILARITY_SATURATION_M', default: 1200, min: 1, unit: 'm',
      description: 'Mean route separation at which similarity reaches 0 (s = 1 − d̄/sat).',
      decision: 'algo-route-similarity: 1200 m saturation distance.',
    }),
  },

  rides: {
    noShowWaitMs: ms({
      env: 'RIDE_NO_SHOW_WAIT_MS', default: 5 * MIN, min: 0, unit: 'ms',
      description: 'Driver must wait this long after `arrived` before reporting a no-show.',
      decision: 'RCAB-E4.S8: 5 min no-show wait (driver app mirrors it).',
    }),
    clientCancellableFrom: listOf({
      env: null, default: ['requested', 'dispatching', 'accepted', 'en_route', 'arrived'],
      allowed: LIVE_RIDE_STATES, unit: 'states',
      description: 'Ride states the client may cancel from (any time before the trip starts).',
      decision: 'RCAB-E4.S8 cancellation rules; no cancel fee in Phase-0.',
    }),
    driverCancellableFrom: listOf({
      env: null, default: ['requested', 'dispatching', 'accepted', 'en_route', 'arrived', 'in_progress'],
      allowed: LIVE_RIDE_STATES, unit: 'states',
      description: 'Ride states the bound driver may cancel from (any time before completion).',
      decision: 'RCAB-E4.S8 cancellation rules.',
    }),
  },

  drivers: {
    autoOfflineSweepMs: ms({
      env: 'DRIVER_AUTO_OFFLINE_SWEEP_MS', default: 15_000, min: 1000, max: 59_000, unit: 'ms',
      description: 'How often the auto-offline sweep runs (whole seconds dividing 60; a cron).',
      decision: 'RCAB-E3.S4: sweep every 15 s.',
    }),
    staleAfterMs: ms({
      env: 'DRIVER_STALE_AFTER_MS', default: 60_000, min: 1000, unit: 'ms',
      description: 'A driver whose last_seen is older than this is forced offline.',
      decision: 'RCAB-E3.S4: 60 s of silence → offline.',
    }),
  },

  realtime: {
    locationFanoutMs: ms({
      env: 'REALTIME_LOCATION_FANOUT_MS', default: 1000, min: 0, unit: 'ms',
      description: 'Min gap between driver_location pushes to a ride room (1 Hz smooth dot).',
      decision: 'RCAB-E4.S7: client fan-out throttled to 1 Hz.',
    }),
    geoIndexGateMs: ms({
      env: 'REALTIME_GEO_INDEX_GATE_MS', default: 3000, min: 0, unit: 'ms',
      description: 'Min gap between geo-index / last_seen writes per driver.',
      decision: 'RCAB-E3.S5: geo-index freshness gate 3 s.',
    }),
  },

  sessions: {
    accessTokenTtlS: int({
      env: 'ACCESS_TOKEN_TTL_S', default: 900, min: 60, unit: 's',
      description: 'Lifetime of an rcab access JWT (returned as expires_in).',
      decision: 'RCAB-E2.S2: 15 min access token.',
    }),
    refreshTokenTtlMs: ms({
      env: 'REFRESH_TOKEN_TTL_MS', default: 30 * DAY, min: MIN, unit: 'ms',
      description: 'Lifetime of a refresh token (DB expiry and refresh cookie maxAge).',
      decision: 'RCAB-E2.S2: 30-day refresh session.',
    }),
    refreshReuseGraceS: int({
      env: 'REFRESH_REUSE_GRACE_S', default: 10, min: 0, unit: 's',
      description: 'A just-rotated refresh token reused within this window gets a plain 401, not a family revoke.',
      decision: 'RCAB-E8.S7 (sessions remediation): 10 s reuse grace for racing clients.',
    }),
    firebaseTokenMaxAgeS: int({
      env: 'FIREBASE_TOKEN_MAX_AGE_S', default: 3600, min: 60, unit: 's',
      description: 'Reject a Firebase ID token whose iat is older than this at exchange.',
      decision: 'RCAB-E2.S1: matches Firebase ID-token lifetime (1 h).',
    }),
  },

  idempotency: {
    pendingReclaimMs: ms({
      env: 'IDEMPOTENCY_PENDING_RECLAIM_MS', default: 60_000, min: 1000, unit: 'ms',
      description: 'A `pending` create claim older than this may be reclaimed by a retry.',
      decision: 'RCAB-E8.S7 (idempotency remediation): 60 s reclaim.',
    }),
  },

  rateLimits: {
    globalLimit: int({
      env: 'THROTTLE_GLOBAL_LIMIT', default: 1000, min: 1, unit: 'requests',
      description: 'Default per-client request budget per window (all throttled routes).',
      decision: 'Code default (app.module ThrottlerModule): 1000 / min.',
    }),
    globalWindowMs: ms({
      env: 'THROTTLE_GLOBAL_WINDOW_MS', default: 60_000, min: 1000, unit: 'ms',
      description: 'Window for the default request budget.',
      decision: 'Code default (app.module ThrottlerModule): 1 min.',
    }),
    authLimit: int({
      env: 'THROTTLE_AUTH_LIMIT', default: 10, min: 1, unit: 'requests',
      description: 'Budget for the auth exchange / refresh / logout routes per window.',
      decision: 'Code default (auth.controller @Throttle): 10 / min.',
    }),
    authWindowMs: ms({
      env: 'THROTTLE_AUTH_WINDOW_MS', default: 60_000, min: 1000, unit: 'ms',
      description: 'Window for the auth route budget.',
      decision: 'Code default (auth.controller @Throttle): 1 min.',
    }),
  },

  outbox: {
    relayPollMs: ms({
      env: 'OUTBOX_RELAY_POLL_MS', default: 1000, min: 50, unit: 'ms',
      description: 'Outbox relay poll interval (commits also kick it immediately).',
      decision: 'RCAB-E8.S8 (R07): 1 s backstop poll.',
    }),
    relayBatchSize: int({
      env: 'OUTBOX_RELAY_BATCH', default: 50, min: 1, unit: 'rows',
      description: 'Outbox rows leased per relay tick.',
      decision: 'RCAB-E8.S8 (R07).',
    }),
    relayLeaseMs: ms({
      env: 'OUTBOX_RELAY_LEASE_MS', default: 30_000, min: 1000, unit: 'ms',
      description: 'Lease on a row being published; a crashed publisher is retried after it.',
      decision: 'RCAB-E8.S8 (R07): 30 s lease.',
    }),
    maxPublishAttempts: int({
      env: 'OUTBOX_MAX_ATTEMPTS', default: 10, min: 1, unit: 'attempts',
      description: 'Publish attempts before an outbox row is marked exhausted (reconciler may re-arm).',
      decision: 'RCAB-E8.S8 migration 0015 column default max_attempts = 10.',
    }),
    jobAttempts: int({
      env: 'OUTBOX_JOB_ATTEMPTS', default: 5, min: 1, unit: 'attempts',
      description: 'BullMQ attempts for published dispatch-start, pool-expire and scheduled-wake jobs.',
      decision: 'RCAB-E8.S8 (R07): 5 attempts.',
    }),
    jobBackoffMs: ms({
      env: 'OUTBOX_JOB_BACKOFF_MS', default: 1000, min: 1, unit: 'ms',
      description: 'Base delay of the exponential BullMQ retry backoff for those jobs.',
      decision: 'RCAB-E8.S8 (R07): exponential from 1 s.',
    }),
    reconcileIntervalMs: ms({
      env: 'OUTBOX_RECONCILE_INTERVAL_MS', default: 5 * MIN, min: 1000, unit: 'ms',
      description: 'How often the dispatch reconciler rebuilds missing work from Postgres (also on boot).',
      decision: 'RCAB-E8.S8 (R07): every 5 min.',
    }),
    reconcileGraceMs: ms({
      env: 'OUTBOX_RECONCILE_GRACE_MS', default: 15_000, min: 0, unit: 'ms',
      description: 'Trips touched more recently than this are skipped (likely mid-flight).',
      decision: 'RCAB-E8.S8 (R07): 15 s grace.',
    }),
    reconcileMaxPerPass: int({
      env: 'OUTBOX_RECONCILE_MAX_PER_PASS', default: 500, min: 1, unit: 'trips',
      description: 'Upper bound of trips inspected per reconcile query.',
      decision: 'RCAB-E8.S8 (R07).',
    }),
  },
} as const satisfies Record<string, Record<string, Knob>>;

export type PolicySchema = typeof POLICY_SCHEMA;
export type PolicyCategory = keyof PolicySchema;

/** Overview headings, in render order. */
export const POLICY_CATEGORIES: Record<PolicyCategory, { title: string; blurb: string }> = {
  pricing: { title: 'Pricing & fares', blurb: 'Solo fare formula, shared seat multipliers, quotes.' },
  dispatch: { title: 'Dispatch (normal rides)', blurb: 'Top-K waves, radii, offer TTL and timers.' },
  scheduled: { title: 'Scheduled booking', blurb: 'Booking window, wake lead and the scheduled accept window.' },
  matching: { title: 'Shared-ride matching & pools', blurb: 'Pool size, timeout, detour and similarity.' },
  rides: { title: 'Ride lifecycle', blurb: 'No-show wait and who may cancel from which state.' },
  drivers: { title: 'Driver presence', blurb: 'Auto-offline sweep.' },
  realtime: { title: 'Realtime', blurb: 'Location fan-out and geo-index cadence.' },
  sessions: { title: 'Sessions & auth', blurb: 'Token lifetimes and refresh rotation grace.' },
  idempotency: { title: 'Idempotency', blurb: 'Create-request claim reclaim.' },
  rateLimits: { title: 'Rate limits', blurb: 'HTTP throttling.' },
  outbox: { title: 'Outbox relay & reconciler', blurb: 'Durable work publication, retries and repair loop.' },
};

// ── Derived types ────────────────────────────────────────────────────────────

type ValueOf<K> = K extends { type: 'enum'; allowed: readonly (infer V)[] }
  ? V
  : K extends { type: 'list'; allowed: readonly (infer V)[] }
    ? readonly V[]
    : K extends { type: 'bool' }
      ? boolean
      : number;

/** The typed, frozen policy object every consumer reads. */
export type Policy = {
  readonly [C in keyof PolicySchema]: {
    readonly [N in keyof PolicySchema[C]]: ValueOf<PolicySchema[C][N]>;
  };
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// ── Cross-field rules ────────────────────────────────────────────────────────

export interface PolicyRule {
  /** Policy keys involved (their env vars are named in the failure message). */
  keys: string[];
  /** The invariant, in words. */
  description: string;
  check: (p: Policy) => boolean;
}

export const POLICY_RULES: readonly PolicyRule[] = [
  {
    keys: ['scheduled.dispatchWaveOneMs', 'scheduled.dispatchWindowMs'],
    description: 'scheduled wave 2 must start within the window (waveOneMs ≤ windowMs)',
    check: (p) => p.scheduled.dispatchWaveOneMs <= p.scheduled.dispatchWindowMs,
  },
  {
    keys: ['scheduled.minLeadMs', 'scheduled.maxLeadMs'],
    description: 'the scheduled booking window must be non-empty (minLeadMs < maxLeadMs)',
    check: (p) => p.scheduled.minLeadMs < p.scheduled.maxLeadMs,
  },
  {
    keys: ['dispatch.r1Meters', 'dispatch.r2Meters'],
    description: 'wave 2 widens the search (r1Meters ≤ r2Meters)',
    check: (p) => p.dispatch.r1Meters <= p.dispatch.r2Meters,
  },
  {
    keys: ['dispatch.waveOneTimeoutMs', 'dispatch.hardFailMs'],
    description: 'wave 2 must start before the hard fail (waveOneTimeoutMs < hardFailMs)',
    check: (p) => p.dispatch.waveOneTimeoutMs < p.dispatch.hardFailMs,
  },
  {
    keys: ['pricing.seatMultiplier3', 'pricing.seatMultiplier2'],
    description: 'a fuller pool is never dearer per seat (seatMultiplier3 ≤ seatMultiplier2)',
    check: (p) => p.pricing.seatMultiplier3 <= p.pricing.seatMultiplier2,
  },
  {
    keys: ['pricing.sharedQuoteSeats', 'matching.maxSeats'],
    description: 'the up-front shared quote must assume a reachable pool size (sharedQuoteSeats ≤ maxSeats)',
    check: (p) => p.pricing.sharedQuoteSeats <= p.matching.maxSeats,
  },
  {
    keys: ['drivers.autoOfflineSweepMs'],
    description: 'the sweep is a seconds cron: whole seconds that divide 60',
    check: (p) =>
      p.drivers.autoOfflineSweepMs % 1000 === 0 && 60 % (p.drivers.autoOfflineSweepMs / 1000) === 0,
  },
  {
    keys: ['realtime.geoIndexGateMs', 'drivers.staleAfterMs'],
    description: 'last_seen is refreshed through the geo gate, so it must be shorter than the stale cutoff',
    check: (p) => p.realtime.geoIndexGateMs < p.drivers.staleAfterMs,
  },
  {
    keys: ['sessions.accessTokenTtlS', 'sessions.refreshTokenTtlMs'],
    description: 'an access token never outlives its refresh session (accessTokenTtlS × 1000 < refreshTokenTtlMs)',
    check: (p) => p.sessions.accessTokenTtlS * 1000 < p.sessions.refreshTokenTtlMs,
  },
];
