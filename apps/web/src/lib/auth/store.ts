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
  setAuth: (user: AuthUser, jwt: string) => void;
  signOut: () => void;
  silentRefresh: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  jwt: null,

  setAuth(user, jwt) {
    set({ user, jwt });
  },

  signOut() {
    set({ user: null, jwt: null });
  },

  async silentRefresh() {
    try {
      // No body — browser sends the HttpOnly refresh_token cookie automatically.
      const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        set({ user: null, jwt: null });
        return;
      }
      const data = (await res.json()) as { access_token: string; user: AuthUser };
      set({ jwt: data.access_token, user: data.user });
    } catch {
      set({ user: null, jwt: null });
    }
  },
}));
