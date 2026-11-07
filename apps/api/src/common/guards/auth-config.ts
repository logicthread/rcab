/**
 * Startup-validated authentication configuration (F11).
 *
 * Only NODE_ENV=development|test may fall back to built-in defaults. Every
 * other value — including an unset NODE_ENV — is treated as production-like
 * and fails closed: the process refuses to start rather than sign tokens with a
 * public secret or accept credentialed requests from an undeclared origin.
 *
 * Error messages name the variable and the rule that failed, never the value
 * of a secret.
 */

type Env = Record<string, string | undefined>;

/** Public, well-known — only ever used when NODE_ENV is development or test. */
export const DEV_JWT_SECRET = 'dev-secret-change-in-prod';
export const MIN_JWT_SECRET_BYTES = 32;

// Web app (3002) plus the legacy dev defaults the CORS/CSRF lists used to carry.
export const DEV_BROWSER_ORIGINS: readonly string[] = [
  'http://localhost:3002',
  'http://localhost:3001',
  'http://localhost:3000',
];

const DEV_LIKE_ENVS = new Set(['development', 'test']);

// Template/placeholder values copied from examples or docs.
const PLACEHOLDER_RE = /change[-_ ]?(me|in[-_ ]?prod|this)|replace[-_ ]?me|<[^>]*>|^(secret|password|changeme|jwt[-_]?secret)$/i;

export function isDevLikeEnv(env: Env = process.env): boolean {
  return DEV_LIKE_ENVS.has(env.NODE_ENV ?? '');
}

function envLabel(env: Env): string {
  return env.NODE_ENV ? `NODE_ENV=${env.NODE_ENV}` : 'NODE_ENV unset';
}

/**
 * Returns the HS256 signing secret. In development/test an empty JWT_SECRET
 * falls back to {@link DEV_JWT_SECRET} (reported through `onDevFallback`);
 * anywhere else it must be present, at least 32 bytes, not a placeholder and
 * not trivially low-entropy.
 */
export function resolveJwtSecret(env: Env = process.env, onDevFallback?: () => void): string {
  const secret = env.JWT_SECRET ?? '';
  const trimmed = secret.trim();

  if (isDevLikeEnv(env)) {
    if (trimmed === '') {
      onDevFallback?.();
      return DEV_JWT_SECRET;
    }
    return secret;
  }

  const hint = 'Generate one with `openssl rand -hex 32` (or set NODE_ENV=development for local dev).';
  if (trimmed === '') {
    throw new Error(`JWT_SECRET must be set (${envLabel(env)}). ${hint}`);
  }
  if (trimmed !== secret) {
    throw new Error('JWT_SECRET must not have leading or trailing whitespace.');
  }
  if (secret === DEV_JWT_SECRET || PLACEHOLDER_RE.test(secret)) {
    throw new Error(`JWT_SECRET is a placeholder value (${envLabel(env)}). ${hint}`);
  }
  if (Buffer.byteLength(secret, 'utf8') < MIN_JWT_SECRET_BYTES) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes (${envLabel(env)}). ${hint}`);
  }
  if (new Set(secret).size < 8) {
    throw new Error(`JWT_SECRET is too repetitive to be a random secret (${envLabel(env)}). ${hint}`);
  }
  return secret;
}

function parseOriginList(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function validateOrigin(origin: string, requireHttps: boolean): void {
  if (origin === '*' || origin === 'null') {
    throw new Error(`CORS_ORIGINS must not contain "${origin}" (credentialed requests need explicit origins).`);
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`CORS_ORIGINS entry "${origin}" is not a valid origin.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`CORS_ORIGINS entry "${origin}" must use http or https.`);
  }
  if (url.origin !== origin) {
    throw new Error(
      `CORS_ORIGINS entry "${origin}" must be a bare origin (scheme://host[:port]) with no path or trailing slash.`,
    );
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error(`CORS_ORIGINS entry "${origin}" must use https outside development/test.`);
  }
}

/**
 * The single browser-origin allowlist shared by credentialed CORS (main.ts) and
 * the CSRF Origin check (CsrfGuard), so the two can never disagree.
 *
 * Source: CORS_ORIGINS. ALLOWED_ORIGINS is accepted as a legacy alias when
 * CORS_ORIGINS is unset; setting both to different lists is rejected as
 * contradictory. Outside development/test the list is required, must not be a
 * wildcard and every entry must be an https origin.
 */
export function resolveBrowserOrigins(env: Env = process.env): string[] {
  const cors = parseOriginList(env.CORS_ORIGINS ?? '');
  const legacy = parseOriginList(env.ALLOWED_ORIGINS ?? '');

  if (cors.length > 0 && legacy.length > 0 && [...cors].sort().join(',') !== [...legacy].sort().join(',')) {
    throw new Error('CORS_ORIGINS and ALLOWED_ORIGINS are both set but differ; set CORS_ORIGINS only.');
  }

  const list = cors.length > 0 ? cors : legacy;
  if (list.length === 0) {
    if (isDevLikeEnv(env)) return [...DEV_BROWSER_ORIGINS];
    throw new Error(
      `CORS_ORIGINS must list the web app's browser origin(s), e.g. https://app.example.com (${envLabel(env)}).`,
    );
  }

  const requireHttps = !isDevLikeEnv(env);
  for (const origin of list) validateOrigin(origin, requireHttps);
  return [...new Set(list)];
}
