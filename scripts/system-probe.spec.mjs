import { describe, it, expect, vi } from 'vitest';
import { detectDeps, buildCapacityModel, inventoryHost } from './system-probe.mjs';

// ---------------------------------------------------------------------------
// detectDeps
// ---------------------------------------------------------------------------
describe('detectDeps', () => {
  it('marks all deps ok when all commands return valid output', () => {
    const run = vi.fn((cmd, args) => {
      const key = `${cmd} ${args[0]}`;
      return {
        'docker --version': 'Docker version 26.1.1, build abc123',
        'docker compose': 'v2.27.0',
        'node --version': 'v22.2.0',
        'pnpm --version': '9.1.0',
        'git --version': 'git version 2.45.0',
        'k6 version': 'k6 v0.51.0 (go1.22.3, linux/amd64)',
      }[key] ?? null;
    });

    const { deps, missing } = detectDeps({ run });

    expect(deps.docker.status).toBe('ok');
    expect(deps.docker_compose.status).toBe('ok');
    expect(deps.node.status).toBe('ok');
    expect(deps.pnpm.status).toBe('ok');
    expect(deps.git.status).toBe('ok');
    expect(deps.k6.status).toBe('ok');
    expect(missing).toHaveLength(0);
  });

  it('reports missing when commands return null', () => {
    const run = vi.fn(() => null);
    const { deps, missing } = detectDeps({ run });

    expect(deps.docker.status).toBe('missing');
    expect(deps.node.status).toBe('missing');
    expect(missing.length).toBeGreaterThanOrEqual(5);
  });

  it('reports version_too_old for node < 20', () => {
    const run = vi.fn((cmd, args) => {
      if (cmd === 'node') return 'v18.20.2';
      return 'ok-value';
    });

    const { deps } = detectDeps({ run });
    expect(deps.node.status).toBe('version_too_old');
    expect(deps.node.minimum).toBe('v20');
  });

  it('marks k6 as optional in missing list', () => {
    const run = vi.fn((cmd) => (cmd === 'k6' ? null : 'some-version'));
    const { missing } = detectDeps({ run });
    const k6Entry = missing.find(m => m.name === 'k6');
    expect(k6Entry).toBeDefined();
    expect(k6Entry.optional).toBe(true);
  });

  it('does not include k6 as critical when it is the only missing dep', () => {
    const run = vi.fn((cmd, args) => {
      if (cmd === 'k6') return null;
      return 'some-version';
    });
    // node needs to be ≥ 20 — override specifically
    const runWithNode = vi.fn((cmd, args) => {
      if (cmd === 'k6')   return null;
      if (cmd === 'node') return 'v20.0.0';
      return 'some-version';
    });
    const { missing } = detectDeps({ run: runWithNode });
    const criticals = missing.filter(m => !m.optional);
    expect(criticals).toHaveLength(0);
  });

  it('handles docker present but docker compose missing', () => {
    const run = vi.fn((cmd, args) => {
      if (cmd === 'docker' && args[0] === '--version') return 'Docker version 26.1.1';
      if (cmd === 'docker' && args[0] === 'compose')  return null;
      return 'some-version';
    });
    const { deps } = detectDeps({ run });
    expect(deps.docker.status).toBe('ok');
    expect(deps.docker_compose.status).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// buildCapacityModel
// ---------------------------------------------------------------------------
describe('buildCapacityModel', () => {
  const host = { cpu_logical_cores: 8, ram_total_gb: 16 };

  it('returns null when loadResult is null', () => {
    expect(buildCapacityModel(host, null)).toBeNull();
  });

  it('returns null when health_ready is absent', () => {
    expect(buildCapacityModel(host, { load: null })).toBeNull();
  });

  it('returns null when rps is zero', () => {
    const load = { health_ready: { rps: 0, p95_ms: 100, error_rate: 0 } };
    expect(buildCapacityModel(host, load)).toBeNull();
  });

  it('computes capacity from RPS', () => {
    const load = { health_ready: { rps: 400, p95_ms: 120, error_rate: 0 } };
    const model = buildCapacityModel(host, load);
    expect(model).not.toBeNull();
    // 400 RPS / 2 RPS per driver = 200 drivers
    expect(model.concurrent_active_drivers).toBe(200);
    // 400 RPS / 0.5 RPS per client = 800 clients
    expect(model.concurrent_active_clients).toBe(800);
  });

  it('marks phase_0_budget_status within when latency and error rate ok', () => {
    const load = { health_ready: { rps: 500, p95_ms: 200, error_rate: 0.001 } };
    const model = buildCapacityModel(host, load);
    expect(model.phase_0_budget_status).toBe('within');
    expect(model.kpi_checks.api_p95_ms.ok).toBe(true);
    expect(model.kpi_checks.error_rate.ok).toBe(true);
  });

  it('marks phase_0_budget_status exceeded when p95 > budget', () => {
    const load = { health_ready: { rps: 10, p95_ms: 600, error_rate: 0 } };
    const model = buildCapacityModel(host, load);
    expect(model.phase_0_budget_status).toBe('exceeded');
    expect(model.kpi_checks.api_p95_ms.ok).toBe(false);
  });

  it('includes kpi_checks for driver and client targets', () => {
    const load = { health_ready: { rps: 400, p95_ms: 120, error_rate: 0 } };
    const model = buildCapacityModel(host, load);
    expect(model.kpi_checks).toHaveProperty('drivers_100');
    expect(model.kpi_checks).toHaveProperty('clients_5k');
    expect(model.kpi_checks.drivers_100.required).toBe(100);
    expect(model.kpi_checks.clients_5k.required).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// inventoryHost (smoke — just checks shape, not values)
// ---------------------------------------------------------------------------
describe('inventoryHost', () => {
  it('returns required fields', () => {
    const inv = inventoryHost();
    expect(inv).toHaveProperty('os');
    expect(inv).toHaveProperty('arch');
    expect(inv).toHaveProperty('cpu_logical_cores');
    expect(inv).toHaveProperty('ram_total_gb');
    expect(inv).toHaveProperty('ram_free_gb');
    expect(typeof inv.cpu_logical_cores).toBe('number');
    expect(inv.cpu_logical_cores).toBeGreaterThan(0);
  });
});
