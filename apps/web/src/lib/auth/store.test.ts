import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore, TOKEN_EXPIRY_SKEW_MS } from './store';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, jwt: null, jwtExpiresAt: null, signedOut: false });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setAuth stores user and jwt', () => {
    const user = { id: 'u1', role: 'client', phone_e164: '+12025551234' };
    useAuthStore.getState().setAuth(user, 'jwt-value');
    const state = useAuthStore.getState();
    expect(state.user).toEqual(user);
    expect(state.jwt).toBe('jwt-value');
  });

  it('signOut clears all auth state', () => {
    useAuthStore.setState({
      user: { id: 'u1', role: 'client', phone_e164: '+1' },
      jwt: 'jwt',
    });
    useAuthStore.getState().signOut();
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.jwt).toBeNull();
  });

  it('silentRefresh sends no body (relies on cookie)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'new-jwt', user: { id: 'u1', role: 'client', phone_e164: '+1' } }),
    } as Response);

    await useAuthStore.getState().silentRefresh();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/auth/refresh'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    const callArg = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(callArg.body).toBeUndefined();
  });

  it('silentRefresh updates jwt and user on successful refresh', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: 'new-jwt', user: { id: 'u1', role: 'client', phone_e164: '+1' } }),
    } as Response);

    await useAuthStore.getState().silentRefresh();

    const state = useAuthStore.getState();
    expect(state.jwt).toBe('new-jwt');
    expect(state.user?.id).toBe('u1');
  });

  it('silentRefresh clears state when refresh endpoint returns non-ok', async () => {
    useAuthStore.setState({
      user: { id: 'u1', role: 'client', phone_e164: '+1' },
      jwt: 'old-jwt',
    });
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    await useAuthStore.getState().silentRefresh();

    const state = useAuthStore.getState();
    expect(state.jwt).toBeNull();
    expect(state.user).toBeNull();
  });

  it('silentRefresh clears state when fetch throws', async () => {
    useAuthStore.setState({ jwt: 'jwt', user: { id: 'u1', role: 'client', phone_e164: '+1' } });
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    await useAuthStore.getState().silentRefresh();

    expect(useAuthStore.getState().jwt).toBeNull();
  });

  describe('signOut (F12)', () => {
    it('POSTs /v1/auth/logout with credentials + Bearer, then state stays cleared', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 204 } as Response);
      useAuthStore.setState({
        user: { id: 'u1', role: 'client', phone_e164: '+1' },
        jwt: 'access-1',
      });

      await useAuthStore.getState().signOut();

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/auth/logout'),
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: { Authorization: 'Bearer access-1' },
        }),
      );
      const s = useAuthStore.getState();
      expect(s.jwt).toBeNull();
      expect(s.user).toBeNull();
      expect(s.signedOut).toBe(true);
    });

    it('clears local state synchronously and still clears when the server is unreachable', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('offline'));
      useAuthStore.setState({ user: { id: 'u1', role: 'client', phone_e164: '+1' }, jwt: 'a' });
      const p = useAuthStore.getState().signOut();
      expect(useAuthStore.getState().jwt).toBeNull();
      await expect(p).resolves.toBeUndefined();
      expect(useAuthStore.getState().signedOut).toBe(true);
    });

    it('does not silently re-login after an explicit sign-out', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
      useAuthStore.setState({ user: { id: 'u1', role: 'client', phone_e164: '+1' }, jwt: 'a' });
      await useAuthStore.getState().signOut();
      vi.mocked(fetch).mockClear();

      await useAuthStore.getState().silentRefresh();

      expect(fetch).not.toHaveBeenCalled();
      expect(useAuthStore.getState().jwt).toBeNull();
    });

    it('a refresh that was in flight at sign-out cannot restore the session', async () => {
      let resolveRefresh!: (r: Response) => void;
      vi.mocked(fetch).mockImplementation((url) =>
        String(url).includes('/refresh')
          ? new Promise<Response>((r) => (resolveRefresh = r))
          : Promise.resolve({ ok: true } as Response),
      );
      useAuthStore.setState({ user: { id: 'u1', role: 'client', phone_e164: '+1' }, jwt: 'old' });
      const refreshing = useAuthStore.getState().refreshAccessToken();
      await useAuthStore.getState().signOut();
      resolveRefresh({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'late',
            user: { id: 'u1', role: 'client', phone_e164: '+1' },
          }),
      } as Response);

      await expect(refreshing).resolves.toBeNull();
      expect(useAuthStore.getState().jwt).toBeNull();
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('setAuth (a new login) lifts the signed-out block', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
      await useAuthStore.getState().signOut();
      useAuthStore.getState().setAuth({ id: 'u2', role: 'client', phone_e164: '+2' }, 'tok');
      expect(useAuthStore.getState().signedOut).toBe(false);
      expect(useAuthStore.getState().jwt).toBe('tok');
    });
  });

  describe('getAccessToken / single-flight refresh (F18b)', () => {
    const user = { id: 'u1', role: 'client', phone_e164: '+1' };
    function jwtExpiringIn(ms: number): string {
      const payload = btoa(JSON.stringify({ exp: Math.floor((Date.now() + ms) / 1000) }));
      return `h.${payload.replace(/=+$/, '')}.s`;
    }
    function refreshOk(token: string) {
      return {
        ok: true,
        json: () => Promise.resolve({ access_token: token, user }),
      } as Response;
    }

    it('returns the current token without refreshing when it is comfortably valid', async () => {
      const tok = jwtExpiringIn(10 * 60_000);
      useAuthStore.getState().setAuth(user, tok);
      await expect(useAuthStore.getState().getAccessToken()).resolves.toBe(tok);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refreshes when the token is expired', async () => {
      useAuthStore.getState().setAuth(user, jwtExpiringIn(-5_000));
      vi.mocked(fetch).mockResolvedValue(refreshOk('fresh'));
      await expect(useAuthStore.getState().getAccessToken()).resolves.toBe('fresh');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().jwt).toBe('fresh');
    });

    it('refreshes when the token is inside the near-expiry skew', async () => {
      useAuthStore.getState().setAuth(user, jwtExpiringIn(TOKEN_EXPIRY_SKEW_MS - 5_000));
      vi.mocked(fetch).mockResolvedValue(refreshOk('fresh2'));
      await expect(useAuthStore.getState().getAccessToken()).resolves.toBe('fresh2');
    });

    it('refreshes when there is no token at all', async () => {
      vi.mocked(fetch).mockResolvedValue(refreshOk('from-cookie'));
      await expect(useAuthStore.getState().getAccessToken()).resolves.toBe('from-cookie');
    });

    it('shares one refresh request between concurrent callers', async () => {
      useAuthStore.getState().setAuth(user, jwtExpiringIn(-1_000));
      vi.mocked(fetch).mockResolvedValue(refreshOk('one'));
      const [a, b, c] = await Promise.all([
        useAuthStore.getState().getAccessToken(),
        useAuthStore.getState().getAccessToken(),
        useAuthStore.getState().refreshAccessToken(),
      ]);
      expect([a, b, c]).toEqual(['one', 'one', 'one']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('treats an opaque (non-JWT) token as valid', async () => {
      useAuthStore.getState().setAuth(user, 'opaque');
      await expect(useAuthStore.getState().getAccessToken()).resolves.toBe('opaque');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
