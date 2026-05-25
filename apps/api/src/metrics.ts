import { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  register,
} from 'prom-client';

collectDefaultMetrics();

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

export const dispatchLatency = new Histogram({
  name: 'rcab_dispatch_latency_seconds',
  help: 'Dispatch latency from request to first offer',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
});

export const dispatchOutcome = new Counter({
  name: 'rcab_dispatch_outcome_total',
  help: 'Dispatch outcomes',
  labelNames: ['outcome'] as const,
});

export const sharedMatchRate = new Gauge({
  name: 'rcab_shared_match_rate',
  help: 'Shared ride match rate (computed every 5 min)',
});

export const activeDrivers = new Gauge({
  name: 'rcab_active_drivers',
  help: 'Number of currently active drivers',
});

export const wsConnections = new Gauge({
  name: 'rcab_ws_connections',
  help: 'Current WebSocket connections',
});

export const rideStateTransition = new Counter({
  name: 'rcab_ride_state_transition_total',
  help: 'Ride state transitions',
  labelNames: ['from', 'to'] as const,
});

export async function metricsHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const metrics = await register.metrics();
  res.writeHead(200, { 'content-type': register.contentType });
  res.end(metrics);
}
