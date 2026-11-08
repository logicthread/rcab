/**
 * Typed numeric configuration helpers (remediation F16 / R02).
 *
 * `ConfigService.get<number>()` is only a type assertion: values that come from
 * the environment are always strings, so `'4000' + 1500 * km` silently becomes
 * string concatenation. These helpers convert, validate (finite, optional
 * integer / range constraints) and reject invalid values loudly instead of
 * coercing them — `Number('')` is 0 and `Number(' ')` is 0, so blank strings are
 * treated as errors rather than as zero.
 */

export interface NumberOptions {
  /** Require a whole number. */
  integer?: boolean;
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
}

/** Minimal shape of `ConfigService` (and of the fakes used in unit tests). */
export interface ConfigReader {
  get(key: string): unknown;
}

export class InvalidConfigError extends Error {
  constructor(
    readonly key: string,
    /** Why the value was rejected, without the value itself. */
    readonly reason: string,
  ) {
    // Deliberately omits the raw value: config can hold secrets.
    super(`Invalid configuration ${key}: ${reason}`);
    this.name = 'InvalidConfigError';
  }
}

/**
 * Convert one raw config value to a validated number. `undefined`/`null` falls
 * back to `defaultValue` (which is validated too).
 */
export function parseNumberConfig(
  key: string,
  raw: unknown,
  defaultValue: number,
  opts: NumberOptions = {},
): number {
  const value = raw === undefined || raw === null ? defaultValue : toNumber(key, raw);

  if (!Number.isFinite(value)) throw new InvalidConfigError(key, 'must be a finite number');
  if (opts.integer && !Number.isInteger(value)) {
    throw new InvalidConfigError(key, 'must be an integer');
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new InvalidConfigError(key, `must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new InvalidConfigError(key, `must be <= ${opts.max}`);
  }
  return value;
}

function toNumber(key: string, raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') throw new InvalidConfigError(key, 'must not be blank');
    return Number(raw);
  }
  throw new InvalidConfigError(key, 'must be a number');
}

/** Read `key` from a ConfigService-like source as a validated number. */
export function getNumber(
  config: ConfigReader,
  key: string,
  defaultValue: number,
  opts: NumberOptions = {},
): number {
  return parseNumberConfig(key, config.get(key), defaultValue, opts);
}

/** Same as {@link getNumber} for plain `process.env` style lookups. */
export function envNumber(
  key: string,
  defaultValue: number,
  opts: NumberOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseNumberConfig(key, env[key], defaultValue, opts);
}
