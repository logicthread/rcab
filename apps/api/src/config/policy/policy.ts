import { InvalidConfigError, parseNumberConfig, type ConfigReader } from '../../common/utils/env';
import {
  POLICY_RULES,
  POLICY_SCHEMA,
  type DeepPartial,
  type Knob,
  type Policy,
  type PolicyCategory,
} from './policy.schema';

/**
 * Builds the frozen business policy (RCAB-E8.S10) from the environment through
 * `POLICY_SCHEMA`. Fail-closed: every invalid knob and every broken cross-field
 * rule is collected and reported together; raw values are never echoed (the
 * same environment holds secrets).
 */

/** Nest injection token for the frozen {@link Policy}. */
export const POLICY = 'RCAB_POLICY';

export type { Policy } from './policy.schema';

/** Where knob values come from: a ConfigService-like reader or a plain env record. */
export type PolicySource = ConfigReader | Readonly<Record<string, unknown>>;

export interface PolicyIssue {
  /** Policy key (`dispatch.offerTtlMs`) or `rule`. */
  key: string;
  /** Env vars involved (empty for a code-fixed knob). */
  env: string[];
  reason: string;
}

export class PolicyValidationError extends Error {
  constructor(readonly issues: readonly PolicyIssue[]) {
    super(
      `Invalid business policy configuration (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n` +
        issues
          .map((i) => `  - ${i.key}${i.env.length ? ` (${i.env.join(', ')})` : ''}: ${i.reason}`)
          .join('\n'),
    );
    this.name = 'PolicyValidationError';
  }
}

export interface KnobEntry {
  /** `category.name` */
  key: string;
  category: PolicyCategory;
  name: string;
  knob: Knob;
}

/** Every knob, in table order. */
export function policyKnobs(): KnobEntry[] {
  const out: KnobEntry[] = [];
  for (const category of Object.keys(POLICY_SCHEMA) as PolicyCategory[]) {
    const group = POLICY_SCHEMA[category] as Record<string, Knob>;
    for (const name of Object.keys(group)) {
      out.push({ key: `${category}.${name}`, category, name, knob: group[name] });
    }
  }
  return out;
}

function reader(source: PolicySource): (env: string) => unknown {
  const maybe = source as Partial<ConfigReader>;
  if (typeof maybe.get === 'function') return (env) => (source as ConfigReader).get(env);
  return (env) => (source as Record<string, unknown>)[env];
}

class KnobError extends Error {}

function parseKnob(
  entry: KnobEntry,
  raw: unknown,
  fromOverride: boolean,
  resolved: Record<string, Record<string, unknown>>,
): unknown {
  const { knob } = entry;
  const label = knob.env ?? entry.key;
  switch (knob.type) {
    case 'int':
    case 'number':
    case 'duration-ms': {
      let fallback: number;
      if (typeof knob.default === 'number') {
        fallback = knob.default;
      } else {
        if (raw === undefined || raw === null) fallback = knob.default.compute(resolved);
        else fallback = Number.NaN; // unused: raw wins
      }
      try {
        return parseNumberConfig(label, raw, fallback, {
          integer: knob.type !== 'number',
          min: knob.min,
          max: knob.max,
        });
      } catch (err) {
        throw new KnobError(err instanceof InvalidConfigError ? err.reason : 'invalid value');
      }
    }
    case 'bool': {
      if (raw === undefined || raw === null) return knob.default;
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      throw new KnobError('must be one of true, false, 1, 0');
    }
    case 'enum': {
      const value = raw === undefined || raw === null ? knob.default : raw;
      if (typeof value !== 'string' || !knob.allowed.includes(value)) {
        throw new KnobError(`must be one of ${knob.allowed.join(', ')}`);
      }
      return value;
    }
    case 'list': {
      if (raw !== undefined && raw !== null && !fromOverride && knob.env === null) {
        throw new KnobError('is code-fixed');
      }
      let value: unknown = raw === undefined || raw === null ? knob.default : raw;
      if (typeof value === 'string') value = value.split(',').map((v) => v.trim()).filter(Boolean);
      if (!Array.isArray(value)) throw new KnobError('must be a list');
      const bad = value.filter((v) => typeof v !== 'string' || !knob.allowed.includes(v));
      if (bad.length > 0) throw new KnobError(`entries must be among ${knob.allowed.join(', ')}`);
      if (new Set(value).size !== value.length) throw new KnobError('must not repeat entries');
      return [...value];
    }
  }
}

/**
 * Parse one raw value for a standalone knob (no derived default). Exposed for
 * unit tests of knob types the table does not currently use (e.g. `bool`).
 * Throws an Error whose message is the reason (never the value).
 */
export function parseKnobValue(key: string, knob: Knob, raw: unknown): unknown {
  const [category, name] = key.split('.') as [PolicyCategory, string];
  return parseKnob({ key, category, name, knob }, raw, false, {});
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/**
 * Read, validate and freeze the policy. `source` defaults to `process.env`;
 * `overrides` (typed values, still validated) are for tests and harnesses.
 * Throws {@link PolicyValidationError} listing every problem.
 */
export function buildPolicy(
  source: PolicySource = process.env,
  overrides: DeepPartial<Policy> = {},
): Policy {
  const read = reader(source);
  const issues: PolicyIssue[] = [];
  const resolved: Record<string, Record<string, unknown>> = {};
  const broken = new Set<string>();

  for (const entry of policyKnobs()) {
    const group = (resolved[entry.category] ??= {});
    const override = (overrides as Record<string, Record<string, unknown> | undefined>)[entry.category]?.[
      entry.name
    ];
    const fromOverride = override !== undefined;
    const raw = fromOverride ? override : entry.knob.env ? read(entry.knob.env) : undefined;

    // A derived default cannot be computed from a broken dependency; that
    // dependency is already reported.
    if (
      (raw === undefined || raw === null) &&
      entry.knob.type !== 'bool' &&
      entry.knob.type !== 'enum' &&
      entry.knob.type !== 'list' &&
      typeof entry.knob.default !== 'number' &&
      broken.size > 0
    ) {
      broken.add(entry.key);
      continue;
    }
    try {
      group[entry.name] = parseKnob(entry, raw, fromOverride, resolved);
    } catch (err) {
      broken.add(entry.key);
      issues.push({
        key: entry.key,
        env: entry.knob.env ? [entry.knob.env] : [],
        reason: err instanceof KnobError ? err.message : 'invalid value',
      });
    }
  }

  if (issues.length === 0) {
    const policy = resolved as unknown as Policy;
    for (const rule of POLICY_RULES) {
      if (!rule.check(policy)) {
        issues.push({
          key: 'rule',
          env: rule.keys.map((k) => envOf(k) ?? k),
          reason: rule.description,
        });
      }
    }
  }

  if (issues.length > 0) throw new PolicyValidationError(issues);
  return deepFreeze(resolved as unknown as Policy);
}

function envOf(key: string): string | null {
  return policyKnobs().find((e) => e.key === key)?.knob.env ?? null;
}

/** The pure defaults (no environment). */
export function defaultPolicy(overrides: DeepPartial<Policy> = {}): Policy {
  return buildPolicy({}, overrides);
}

let current: Policy | null = null;

/**
 * The process-wide policy, built once from `process.env` on first use (module
 * load of a decorator consumer, or `PolicyModule`'s provider at boot) and then
 * frozen. The same object is what `@Inject(POLICY)` resolves to.
 */
export function getPolicy(): Policy {
  current ??= buildPolicy(process.env);
  return current;
}
