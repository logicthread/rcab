'use client';

import { create } from 'zustand';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface AuthUser {
  id: string;
  role: string;
  phone_e164: string;
}

interface AuthState {
  user: AuthUser | null;
  jwt: string | null;
  // Held in memory until S5 wires the HttpOnly cookie.
  refreshToken: string | null;
  setAuth: (user: AuthUser, jwt: string, refreshToken: string) => void;
  signOut: () => void;
  silentRefresh: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  jwt: null,
  refreshToken: null,

  setAuth(user, jwt, refreshToken) {
    set({ user, jwt, refreshToken });
  },

  signOut() {
    set({ user: null, jwt: null, refreshToken: null });
  },

  async silentRefresh() {
    const { refreshToken } = get();
    if (!refreshToken) return;
    try {
      const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) {
        set({ user: null, jwt: null, refreshToken: null });
        return;
      }
      const data = (await res.json()) as { access_token: string; refresh_token: string; user: AuthUser };
      set({ jwt: data.access_token, refreshToken: data.refresh_token, user: data.user });
    } catch {
      set({ user: null, jwt: null, refreshToken: null });
    }
  },
}));
