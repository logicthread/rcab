'use client';

import { create } from 'zustand';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/** Refresh this long before the access token's `exp` so a request never leaves with a token about to lapse. */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

export interface AuthUser {
  id: string;
  role: string;
  phone_e164: string;
}

interface AuthState {
  user: AuthUser | null;
  jwt: string | null;
  /** Epoch ms when `jwt` expires; null when unknown (opaque / undecodable token). */
  jwtExpiresAt: number | null;
  /** True after an explicit sign-out; blocks any silent re-login until setAuth(). */
  signedOut: boolean;
  /** Bumped on every sign-out so a refresh already in flight cannot restore the old session. */
  sessionGen: number;
  setAuth: (user: AuthUser, jwt: string) => void;
  signOut: () => Promise<void>;
  silentRefresh: () => Promise<void>;
  /** Single-flight refresh shared by every caller. Resolves the new token, or null. */
  refreshAccessToken: () => Promise<string | null>;
  /** A usable access token: the current one, or a freshly refreshed one when null/expired/near-expiry. */
  getAccessToken: () => Promise<string | null>;
}

/** Best-effort `exp` (ms) from a JWT payload; null if the token is not a decodable JWT. */
export function decodeJwtExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

let inflightRefresh: Promise<string | null> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  jwt: null,
  jwtExpiresAt: null,
  signedOut: false,
  sessionGen: 0,

  setAuth(user, jwt) {
    set({ user, jwt, jwtExpiresAt: decodeJwtExpiry(jwt), signedOut: false });
  },

  async signOut() {
    const { jwt, jwtExpiresAt, sessionGen } = get();
    // The API's logout is behind AuthGuard (a *valid* Bearer) and CsrfGuard
    // (browser-set Origin). An expired/missing access token would 401 and leave
    // the refresh cookie alive, so a reload would silently log the user back in.
    const needsFreshToken =
      jwt === null || (jwtExpiresAt !== null && jwtExpiresAt - Date.now() <= TOKEN_EXPIRY_SKEW_MS);
    // Drop local state first (and invalidate any in-flight refresh) so the UI
    // leaves the session at once and nothing can silently log back in while the
    // server revokes the refresh token + clears the cookie.
    inflightRefresh = null;
    set({
      user: null,
      jwt: null,
      jwtExpiresAt: null,
      signedOut: true,
      sessionGen: sessionGen + 1,
    });
    try {
      let bearer = jwt;
      if (needsFreshToken) {
        // Raw call (not refreshAccessToken: that is blocked once signedOut and
        // would write the session back into the store). It rotates the cookie,
        // which the logout below then revokes. No session -> nothing to revoke.
        bearer = null;
        const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (res.ok) {
          bearer = ((await res.json()) as { access_token?: string }).access_token ?? null;
        }
        if (!bearer) return;
      }
      // CsrfGuard is Origin-based: the browser attaches Origin itself, so no extra header.
      await fetch(`${API_BASE}/v1/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${bearer}` },
      });
    } catch {
      /* offline: device is cleared locally; server-side revocation is best-effort */
    }
  },

  refreshAccessToken() {
    if (get().signedOut) return Promise.resolve(null);
    if (inflightRefresh) return inflightRefresh;
    const gen = get().sessionGen;
    const clear = () => {
      if (get().sessionGen === gen) set({ user: null, jwt: null, jwtExpiresAt: null });
    };
    const run = async (): Promise<string | null> => {
      try {
        // No body — browser sends the HttpOnly refresh_token cookie automatically.
        const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          clear();
          return null;
        }
        const data = (await res.json()) as { access_token: string; user: AuthUser };
        // A sign-out while the request was in flight wins over this response.
        if (get().sessionGen !== gen) return null;
        set({
          jwt: data.access_token,
          user: data.user,
          jwtExpiresAt: decodeJwtExpiry(data.access_token),
        });
        return data.access_token;
      } catch {
        clear();
        return null;
      }
    };
    const p: Promise<string | null> = run().finally(() => {
      if (inflightRefresh === p) inflightRefresh = null;
    });
    inflightRefresh = p;
    return p;
  },

  async silentRefresh() {
    await get().refreshAccessToken();
  },

  async getAccessToken() {
    const { jwt, jwtExpiresAt } = get();
    if (jwt && (jwtExpiresAt === null || jwtExpiresAt - Date.now() > TOKEN_EXPIRY_SKEW_MS)) {
      return jwt;
    }
    return get().refreshAccessToken();
  },
}));
