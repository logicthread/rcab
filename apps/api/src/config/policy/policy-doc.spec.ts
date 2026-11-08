import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENV_BLOCK_END,
  ENV_BLOCK_START,
  compareGenerated,
  formatAllowed,
  humanMs,
  parseDartPolicy,
  renderEnvBlock,
  renderPolicyDoc,
  spliceEnvBlock,
  webKnobs,
} from './policy-doc';
import { policyKnobs } from './policy';
import { POLICY_SCHEMA } from './policy.schema';

const NO_CLIENTS = { web: [], driver: [] };

describe('renderPolicyDoc', () => {
  const doc = renderPolicyDoc(NO_CLIENTS);

  it('has one row per knob, with its env var (or code-fixed marker) and decision', () => {
    for (const { key, knob } of policyKnobs()) {
      const line = doc.split('\n').find((l) => l.startsWith(`| \`${key}\` |`));
      expect(line, key).toBeDefined();
      expect(line).toContain(knob.env ? `\`${knob.env}\`` : '— (code-fixed)');
      expect(line).toContain(knob.decision.replace(/\|/g, '\\|'));
    }
  });

  it('renders derived defaults, human durations and list defaults', () => {
    expect(doc).toContain('⌊scheduled.dispatchWindowMs / 2⌋ = 120000 (2 min)');
    expect(doc).toContain('| 240000 (4 min) |');
    expect(doc).toContain('`requested`, `dispatching`, `accepted`, `en_route`, `arrived` |');
  });

  it('lists the cross-field rules by env var and the client knobs', () => {
    expect(doc).toContain('`SCHEDULED_DISPATCH_WAVE_ONE_MS`, `SCHEDULED_DISPATCH_WINDOW_MS`');
    const withClients = renderPolicyDoc({
      web: [{ key: 'auth.x', value: '1', unit: 'ms', source: 'client', description: 'd', decision: 'a|b' }],
      driver: [],
    });
    expect(withClients).toContain('| `auth.x` | `1` | ms | client | d | a\\|b |');
  });

  it('is deterministic', () => {
    expect(renderPolicyDoc(NO_CLIENTS)).toBe(doc);
  });
});

describe('env example block', () => {
  const block = renderEnvBlock();

  it('lists every env-overridable knob commented out at its default, grouped by category', () => {
    for (const { knob } of policyKnobs()) {
      if (knob.env) expect(block).toMatch(new RegExp(`^# ${knob.env}=`, 'm'));
    }
    expect(block).toContain('# SCHEDULED_DISPATCH_WINDOW_MS=240000');
    expect(block).toContain('# SCHEDULED_DISPATCH_WAVE_ONE_MS=120000');
    expect(block).toContain('# ── Pricing & fares ──');
    expect(block.startsWith(ENV_BLOCK_START)).toBe(true);
    expect(block.endsWith(ENV_BLOCK_END)).toBe(true);
    expect(block).not.toMatch(/^[A-Z_]+=/m); // nothing is set, only documented
  });

  it('splices idempotently: appends once, then replaces in place', () => {
    const base = 'A=1\n# keep me\n';
    const once = spliceEnvBlock(base, block);
    expect(once).toBe(`A=1\n# keep me\n\n${block}\n`);
    expect(spliceEnvBlock(once, block)).toBe(once);
    const replaced = spliceEnvBlock(once, `${ENV_BLOCK_START}\n# X=1\n${ENV_BLOCK_END}`);
    expect(replaced).toBe(`A=1\n# keep me\n\n${ENV_BLOCK_START}\n# X=1\n${ENV_BLOCK_END}\n`);
  });
});

describe('compareGenerated (the policy:doc:check core)', () => {
  it('passes on identical content', () => {
    expect(compareGenerated('f', 'a\nb', 'a\nb')).toBeNull();
  });
  it('names a missing file', () => {
    expect(compareGenerated('docs/POLICY.md', 'a', null)).toBe('docs/POLICY.md is missing');
  });
  it('names the first stale line', () => {
    expect(compareGenerated('f', 'a\nb\nc', 'a\nX\nc')).toBe('f is stale at line 2 (expected: "b")');
    expect(compareGenerated('f', 'a\nb', 'a')).toBe('f is stale at line 2 (expected: "b")');
    expect(compareGenerated('f', 'a', 'a\nextra')).toBe('f is stale at line 2 (expected: "<eof>")');
  });
  it('detects a hand edit of a default in the rendered doc', () => {
    const doc = renderPolicyDoc(NO_CLIENTS);
    const edited = doc.replace('| `DISPATCH_K1` | 5 |', '| `DISPATCH_K1` | 6 |');
    expect(edited).not.toBe(doc);
    expect(compareGenerated('docs/POLICY.md', doc, edited)).toMatch(/stale at line \d+/);
  });
});

describe('client knob sources', () => {
  it('flattens the web policy and rejects drift between values and meta', () => {
    const meta = {
      'a.x': { unit: 'ms', source: 'client' as const, description: 'x', decision: 'y' },
      'a.list': { unit: 'ms list', source: 'client' as const, description: 'x', decision: 'y' },
    };
    expect(webKnobs({ a: { x: 1, list: [1, 2] } }, meta).map((k) => [k.key, k.value])).toEqual([
      ['a.x', '1'],
      ['a.list', '[1, 2]'],
    ]);
    expect(() => webKnobs({ a: { x: 1, list: [1], y: 2 } }, meta)).toThrow(/without WEB_POLICY_META \[a\.y\]/);
    expect(() => webKnobs({ a: { x: 1 } }, meta)).toThrow(/meta without value \[a\.list\]/);
  });

  it('parses annotated Dart consts and rejects an undocumented one', () => {
    const ok = [
      'class DriverPolicy {',
      '  /// Ack wait.',
      '  /// unit: duration | source: client | decision: eight seconds.',
      '  static const Duration ackTimeout = Duration(seconds: 8);',
      '}',
    ].join('\n');
    expect(parseDartPolicy(ok)).toEqual([
      {
        key: 'ackTimeout',
        value: 'Duration(seconds: 8)',
        unit: 'duration',
        source: 'client',
        description: 'Ack wait.',
        decision: 'eight seconds.',
      },
    ]);
    expect(() => parseDartPolicy(`${ok}\n  static const int bare = 1;`)).toThrow(/without the required doc comment/);
    expect(() => parseDartPolicy('  /// Only a description.\n  static const int x = 1;')).toThrow(/needs a description/);
  });

  it('parses the real driver-app policy file', () => {
    const src = readFileSync(join(__dirname, '../../../../driver-app/lib/core/config/policy.dart'), 'utf8');
    const knobs = parseDartPolicy(src);
    expect(knobs.map((k) => k.key)).toContain('sharedAcceptAckTimeout');
    expect(knobs.find((k) => k.key === 'sharedAcceptAckTimeout')?.value).toBe('Duration(seconds: 8)');
  });
});

describe('formatting helpers', () => {
  it('humanMs picks the largest exact unit', () => {
    expect(humanMs(12_000)).toBe('12 s');
    expect(humanMs(240_000)).toBe('4 min');
    expect(humanMs(86_400_000)).toBe('1 d');
    expect(humanMs(1500)).toBe('1500 ms');
    expect(humanMs(0)).toBe('0 ms');
  });

  it('formatAllowed covers every knob type', () => {
    expect(formatAllowed(POLICY_SCHEMA.pricing.seatMultiplier2)).toBe('number 0.01 – 1');
    expect(formatAllowed(POLICY_SCHEMA.dispatch.k1)).toBe('integer ≥ 1');
    expect(formatAllowed(POLICY_SCHEMA.pricing.sharedFarePolicy)).toBe('`fixed_at_join`');
    expect(formatAllowed(POLICY_SCHEMA.rides.clientCancellableFrom)).toMatch(/^subset of `requested`/);
    expect(
      formatAllowed({ type: 'bool', env: null, default: true, unit: '-', description: 'd', decision: 'd' }),
    ).toBe('true / false');
    expect(
      formatAllowed({ type: 'int', env: null, default: 1, max: 5, unit: '-', description: 'd', decision: 'd' }),
    ).toBe('integer ≤ 5');
    expect(formatAllowed({ type: 'number', env: null, default: 1, unit: '-', description: 'd', decision: 'd' })).toBe(
      'number',
    );
  });
});
