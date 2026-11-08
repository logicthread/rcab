import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  register,
} from 'prom-client';

/**
 * Prometheus instruments (RCAB-E8.S12 / R12).
 *
 * Rules every metric here follows:
 *  - Each one has a real call site at an authoritative state change (after the
 *    transaction that made it true committed) or in the periodic sampler
 *    (`BusinessMetricsSampler`). A metric nothing updates is deleted, not kept.
 *  - Label values come from small closed vocabularies (typed below). Never a
 *    user / ride / driver id, coordinate, token or raw URL path.
 *  - Counters count COMMITTED state changes once; attempts and retries are
 *    counted separately (`rcab_outbox_publish_total{result}`).
 */

function getOrCreate<T>(name: string, create: () => T): T {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as T;
  return create();
}

if (!register.getSingleMetric('process_cpu_user_seconds_total')) {
  collectDefaultMetrics();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** `route` is the Nest/Express route TEMPLATE (`/v1/rides/:id`), or {@link UNMATCHED_ROUTE}. */
export const httpRequestDuration = getOrCreate(
  'http_request_duration_seconds',
  () => new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by route template',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
) as Histogram<'method' | 'route' | 'status_code'>;

/** Fixed route label for requests that matched no route (404s, preflights, scanners). */
export const UNMATCHED_ROUTE = 'unmatched';

// ── Dispatch ─────────────────────────────────────────────────────────────────

export type TripKindLabel = 'solo' | 'pool';

/**
 * - `intent_to_first_offer`: durable dispatch intent (outbox row) -> the first
 *   offer of that generation committed. Includes relay + queue delay.
 * - `offer_to_accept`: that offer's creation -> its acceptance committed.
 */
export type DispatchLatencyStage = 'intent_to_first_offer' | 'offer_to_accept';

export const dispatchLatency = getOrCreate(
  'rcab_dispatch_latency_seconds',
  () => new Histogram({
    name: 'rcab_dispatch_latency_seconds',
    help: 'Dispatch latency by stage (intent_to_first_offer, offer_to_accept)',
    labelNames: ['stage', 'kind'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 30],
  }),
) as Histogram<'stage' | 'kind'>;

/**
 * Terminal / noteworthy dispatch results (denominator = dispatch generations
 * that reached a verdict, not requests):
 *  - `assigned`        a driver's accept committed (replays are not recounted)
 *  - `no_driver`       a normal ride hard-failed with no driver
 *  - `pool_aborted`    a closed pool hard-failed with no driver
 *  - `scheduled_retry` a scheduled ride's window closed empty and was re-armed
 *  - `cancelled`       a ride was cancelled while still unassigned (dispatching)
 *  - `infra_failure`   a dispatch job exhausted its BullMQ attempts
 */
export type DispatchOutcomeLabel =
  | 'assigned'
  | 'no_driver'
  | 'pool_aborted'
  | 'scheduled_retry'
  | 'cancelled'
  | 'infra_failure';

export const dispatchOutcome = getOrCreate(
  'rcab_dispatch_outcome_total',
  () => new Counter({
    name: 'rcab_dispatch_outcome_total',
    help: 'Dispatch outcomes (committed verdicts per dispatch generation)',
    labelNames: ['outcome', 'kind'] as const,
  }),
) as Counter<'outcome' | 'kind'>;

export function recordDispatchOutcome(outcome: DispatchOutcomeLabel, kind: TripKindLabel): void {
  dispatchOutcome.inc({ outcome, kind });
}

export function observeDispatchLatency(
  stage: DispatchLatencyStage,
  kind: TripKindLabel,
  seconds: number,
): void {
  // A clock skew between the app and DB clocks must not poison the histogram.
  if (!Number.isFinite(seconds)) return;
  dispatchLatency.observe({ stage, kind }, Math.max(0, seconds));
}

// ── Ride lifecycle ───────────────────────────────────────────────────────────

/** `from` is `none` for the creating insert. Statuses are a closed enum. */
export const rideStateTransition = getOrCreate(
  'rcab_ride_state_transition_total',
  () => new Counter({
    name: 'rcab_ride_state_transition_total',
    help: 'Committed ride state transitions',
    labelNames: ['from', 'to'] as const,
  }),
) as Counter<'from' | 'to'>;

export function recordRideTransition(from: string, to: string): void {
  rideStateTransition.inc({ from, to });
}

// ── Shared pools ─────────────────────────────────────────────────────────────

/** `opened` / `joined` are committed seats; the rest are typed refusals (no seat). */
export type PoolJoinResult =
  | 'opened'
  | 'joined'
  | 'pool_full'
  | 'pool_closed'
  | 'not_found'
  | 'already_member'
  | 'idempotent_replay'
  | 'passenger_has_active_pool'
  | 'conflict';

export const poolJoins = getOrCreate(
  'rcab_pool_joins_total',
  () => new Counter({
    name: 'rcab_pool_joins_total',
    help: 'Shared-pool seat requests by result (opened/joined are committed seats)',
    labelNames: ['result'] as const,
  }),
) as Counter<'result'>;

export type PoolCloseLabel = 'closed_full' | 'closed_timeout' | 'aborted_empty';

export const poolClosures = getOrCreate(
  'rcab_pool_closures_total',
  () => new Counter({
    name: 'rcab_pool_closures_total',
    help: 'Open pools leaving the open state (full, timeout, aborted while empty)',
    labelNames: ['reason'] as const,
  }),
) as Counter<'reason'>;

export const sharedMatchRate = getOrCreate(
  'rcab_shared_match_rate',
  () => new Gauge({
    name: 'rcab_shared_match_rate',
    help:
      'Share of riders in pools closed within the match-rate window that rode with at least one other rider (absent when no pool closed)',
  }),
) as Gauge<string>;

// ── Outbox (required-work health) ────────────────────────────────────────────

export type OutboxPublishResult = 'published' | 'retry' | 'exhausted' | 'lost_lease';

export const outboxPublish = getOrCreate(
  'rcab_outbox_publish_total',
  () => new Counter({
    name: 'rcab_outbox_publish_total',
    help: 'Outbox publish attempts by result (attempts, not business completions)',
    labelNames: ['result'] as const,
  }),
) as Counter<'result'>;

export const outboxPending = getOrCreate(
  'rcab_outbox_pending',
  () => new Gauge({ name: 'rcab_outbox_pending', help: 'Outbox rows not yet published or exhausted' }),
) as Gauge<string>;

export const outboxOldestPendingAge = getOrCreate(
  'rcab_outbox_oldest_pending_age_seconds',
  () => new Gauge({
    name: 'rcab_outbox_oldest_pending_age_seconds',
    help: 'Age of the oldest DUE unpublished outbox row (0 when nothing is due)',
  }),
) as Gauge<string>;

export const outboxExhausted = getOrCreate(
  'rcab_outbox_exhausted',
  () => new Gauge({
    name: 'rcab_outbox_exhausted',
    help: 'Outbox rows that exhausted their publish attempts (need the reconciler or an operator)',
  }),
) as Gauge<string>;

// ── Presence / realtime ──────────────────────────────────────────────────────

export const activeDrivers = getOrCreate(
  'rcab_active_drivers',
  () => new Gauge({
    name: 'rcab_active_drivers',
    help: 'Drivers in the online geo index (stale ones are swept by the auto-offline cron)',
  }),
) as Gauge<string>;

export const busyDrivers = getOrCreate(
  'rcab_busy_drivers',
  () => new Gauge({
    name: 'rcab_busy_drivers',
    help: 'Drivers holding an active trip assignment (Postgres), measured separately from geo members',
  }),
) as Gauge<string>;

export const wsConnections = getOrCreate(
  'rcab_ws_connections',
  () => new Gauge({ name: 'rcab_ws_connections', help: 'Authenticated WebSocket connections on this node' }),
) as Gauge<string>;
