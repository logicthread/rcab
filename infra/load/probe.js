/**
 * k6 load scenario for `pnpm system:probe`
 *
 * Targets /v1/health/ready as a proxy for the full application stack
 * (exercises Postgres + Redis + OSRM in one request).
 *
 * Three scenarios:
 *   health_read  — sustained read throughput (proxy for quote path)
 *   health_write — lightweight concurrent probe (proxy for dispatch path)
 *   health_flood — brief spike to find the saturation point
 *
 * Full quote + dispatch scenarios will replace these in E4.
 *
 * Env vars (set by system-probe.mjs):
 *   API_BASE      — e.g. http://localhost:3000
 *   SUMMARY_FILE  — path to write the JSON summary
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const API_BASE     = __ENV.API_BASE     || 'http://localhost:3000';
const SUMMARY_FILE = __ENV.SUMMARY_FILE || '/tmp/k6-probe-summary.json';

export const options = {
  scenarios: {
    // Sustained moderate load — measures p95 under normal conditions
    health_read: {
      executor: 'constant-vus',
      vus: 20,
      duration: '60s',
      gracefulStop: '5s',
    },
    // Concurrent write-proxy — measures contention under parallel requests
    health_write: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
      startTime: '65s',
      gracefulStop: '5s',
    },
    // Ramp to saturation — finds the knee of the latency curve
    health_flood: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { target: 100, duration: '30s' },
        { target: 100, duration: '30s' },
      ],
      startTime: '135s',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    // Non-failing: we report rather than abort so the probe always emits a report
    'http_req_duration{scenario:health_read}':  ['p(95)<1000'],
    'http_req_duration{scenario:health_write}': ['p(95)<2000'],
    'http_req_failed':                          ['rate<0.10'],
  },
};

export default function () {
  const res = http.get(`${API_BASE}/v1/health/ready`, {
    tags: { endpoint: 'health_ready' },
    timeout: '10s',
  });
  check(res, { 'status 200 or 503': (r) => r.status === 200 || r.status === 503 });
  sleep(0.1);
}

export function handleSummary(data) {
  return {
    [SUMMARY_FILE]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
