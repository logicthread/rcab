import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from './store';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, jwt: null });
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
});
