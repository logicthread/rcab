/**
 * Public sign-in configuration (RCAB-E8.S15). The API owns which methods are
 * enabled (policy `auth.enabledMethods`); the client renders only those.
 *
 * Shape of `GET /v1/auth/config` (public, no auth):
 *   { "methods": ["google"], "google": { "clientId": "<web client id> | null" } }
 */

export type AuthMethod = 'google' | 'phone';

export interface AuthConfig {
  methods: AuthMethod[];
  google: { clientId: string | null };
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const KNOWN_METHODS: readonly AuthMethod[] = ['google', 'phone'];

/** Narrow an untrusted payload to AuthConfig; unknown methods are dropped, never trusted. */
export function parseAuthConfig(raw: unknown): AuthConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('auth config: not an object');
  const o = raw as { methods?: unknown; google?: { clientId?: unknown } | null };
  if (!Array.isArray(o.methods)) throw new Error('auth config: methods missing');
  const methods = o.methods.filter((m): m is AuthMethod =>
    (KNOWN_METHODS as readonly unknown[]).includes(m),
  );
  const rawId = o.google?.clientId;
  const clientId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : null;
  return { methods, google: { clientId } };
}

export async function fetchAuthConfig(signal?: AbortSignal): Promise<AuthConfig> {
  const res = await fetch(`${API_BASE}/v1/auth/config`, { signal });
  if (!res.ok) throw new Error(`auth config: HTTP ${res.status}`);
  return parseAuthConfig(await res.json());
}

/** Client id from the API config, else the build-time fallback. */
export function resolveGoogleClientId(config: AuthConfig): string | null {
  return config.google.clientId ?? (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() || null);
}
