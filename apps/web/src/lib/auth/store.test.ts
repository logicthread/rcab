import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from './store';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, jwt: null, refreshToken: null });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setAuth stores user, jwt, and refreshToken', () => {
    const user = { id: 'u1', role: 'client', phone_e164: '+12025551234' };
    useAuthStore.getState().setAuth(user, 'jwt-value', 'rt-value');
    const state = useAuthStore.getState();
    expect(state.user).toEqual(user);
    expect(state.jwt).toBe('jwt-value');
    expect(state.refreshToken).toBe('rt-value');
  });

  it('signOut clears all auth state', () => {
    useAuthStore.setState({
      user: { id: 'u1', role: 'client', phone_e164: '+1' },
      jwt: 'jwt',
      refreshToken: 'rt',
    });
    useAuthStore.getState().signOut();
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.jwt).toBeNull();
    expect(state.refreshToken).toBeNull();
  });

  it('silentRefresh is a no-op when no refreshToken', async () => {
    await useAuthStore.getState().silentRefresh();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('silentRefresh updates state on successful refresh', async () => {
    useAuthStore.setState({ refreshToken: 'old-rt' });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'new-jwt',
          refresh_token: 'new-rt',
          user: { id: 'u1', role: 'client', phone_e164: '+1' },
        }),
    } as Response);

    await useAuthStore.getState().silentRefresh();

    const state = useAuthStore.getState();
    expect(state.jwt).toBe('new-jwt');
    expect(state.refreshToken).toBe('new-rt');
    expect(state.user?.id).toBe('u1');
  });

  it('silentRefresh clears state when refresh endpoint returns non-ok', async () => {
    useAuthStore.setState({
      user: { id: 'u1', role: 'client', phone_e164: '+1' },
      jwt: 'old-jwt',
      refreshToken: 'bad-rt',
    });
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);

    await useAuthStore.getState().silentRefresh();

    const state = useAuthStore.getState();
    expect(state.jwt).toBeNull();
    expect(state.user).toBeNull();
    expect(state.refreshToken).toBeNull();
  });

  it('silentRefresh clears state when fetch throws', async () => {
    useAuthStore.setState({ refreshToken: 'rt', jwt: 'jwt' });
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));

    await useAuthStore.getState().silentRefresh();

    expect(useAuthStore.getState().jwt).toBeNull();
  });
});
