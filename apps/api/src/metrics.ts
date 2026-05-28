import { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  register,
} from 'prom-client';

function getOrCreate<T>(name: string, create: () => T): T {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as T;
  return create();
}

if (!register.getSingleMetric('process_cpu_user_seconds_total')) {
  collectDefaultMetrics();
}

export const httpRequestDuration = getOrCreate(
  'http_request_duration_seconds',
  () => new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
) as Histogram<'method' | 'route' | 'status_code'>;

export const dispatchLatency = getOrCreate(
  'rcab_dispatch_latency_seconds',
  () => new Histogram({
    name: 'rcab_dispatch_latency_seconds',
    help: 'Dispatch latency from request to first offer',
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  }),
) as Histogram<string>;

export const dispatchOutcome = getOrCreate(
  'rcab_dispatch_outcome_total',
  () => new Counter({
    name: 'rcab_dispatch_outcome_total',
    help: 'Dispatch outcomes',
    labelNames: ['outcome'] as const,
  }),
) as Counter<'outcome'>;

export const sharedMatchRate = getOrCreate(
  'rcab_shared_match_rate',
  () => new Gauge({ name: 'rcab_shared_match_rate', help: 'Shared ride match rate (computed every 5 min)' }),
) as Gauge<string>;

export const activeDrivers = getOrCreate(
  'rcab_active_drivers',
  () => new Gauge({ name: 'rcab_active_drivers', help: 'Number of currently active drivers' }),
) as Gauge<string>;

export const wsConnections = getOrCreate(
  'rcab_ws_connections',
  () => new Gauge({ name: 'rcab_ws_connections', help: 'Current WebSocket connections' }),
) as Gauge<string>;

export const rideStateTransition = getOrCreate(
  'rcab_ride_state_transition_total',
  () => new Counter({
    name: 'rcab_ride_state_transition_total',
    help: 'Ride state transitions',
    labelNames: ['from', 'to'] as const,
  }),
) as Counter<'from' | 'to'>;

export async function metricsHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const metrics = await register.metrics();
  res.writeHead(200, { 'content-type': register.contentType });
  res.end(metrics);
}
