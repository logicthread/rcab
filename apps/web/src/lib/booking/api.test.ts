import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthStore } from '../auth/store';
import { BookingApiError, fetchRide, createNormalRide, fetchQuote } from './api';

const user = { id: 'u1', role: 'client', phone_e164: '+1' };
const place = { lat: 1, lng: 2, label: 'x' };

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: () => Promise.resolve(body),
  } as Response;
}

function bearer(init: RequestInit | undefined): string {
  return (init!.headers as Record<string, string>).Authorization;
}

describe('booking api auth handling (F18b)', () => {
  beforeEach(() => {
    useAuthStore.setState({ user, jwt: 'old', jwtExpiresAt: null, signedOut: false });
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retries once after a 401 using a refreshed token', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/auth/refresh')) return json(200, { access_token: 'new', user });
      return bearer(init) === 'Bearer new' ? json(200, { rideId: 'r1' }) : json(401, { code: 'x' });
    });
    await expect(fetchRide('r1')).resolves.toEqual({ rideId: 'r1' });
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/auth/refresh'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/v1/rides/r1'))).toHaveLength(2);
  });

  it('shares ONE refresh across concurrent 401s', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/auth/refresh')) {
        await Promise.resolve();
        return json(200, { access_token: 'new', user });
      }
      return bearer(init) === 'Bearer new' ? json(200, { ok: 1 }) : json(401, {});
    });
    await Promise.all([fetchRide('a'), fetchRide('b'), fetchRide('c')]);
    const refreshes = vi
      .mocked(fetch)
      .mock.calls.filter((c) => String(c[0]).includes('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  it('does not retry more than once: a second 401 surfaces as BookingApiError', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/auth/refresh')
        ? json(200, { access_token: 'new', user })
        : json(401, { error: { code: 'unauthorized', message: 'nope' } }),
    );
    await expect(fetchRide('r1')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(
      vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes('/v1/rides/')),
    ).toHaveLength(2);
  });

  it('throws a 401 BookingApiError when the refresh fails (no loop)', async () => {
    vi.mocked(fetch).mockImplementation(async () => json(401, {}));
    await expect(fetchRide('r1')).rejects.toBeInstanceOf(BookingApiError);
    expect(useAuthStore.getState().jwt).toBeNull();
  });

  it('replays the same Idempotency-Key on the post-401 retry', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/auth/refresh')) return json(200, { access_token: 'new', user });
      return bearer(init) === 'Bearer new' ? json(200, { rideId: 'r1' }) : json(401, {});
    });
    await createNormalRide(place, place, 'qt', 'idem-1');
    const rideCalls = vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).endsWith('/v1/rides'));
    expect(rideCalls).toHaveLength(2);
    for (const c of rideCalls) {
      expect((c[1]!.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-1');
    }
  });

  it('refreshes before sending when there is no token', async () => {
    useAuthStore.setState({ jwt: null, user: null });
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/auth/refresh')
        ? json(200, { access_token: 'fresh', user })
        : json(200, {}),
    );
    await fetchRide('r1');
    expect(bearer(vi.mocked(fetch).mock.calls[1][1])).toBe('Bearer fresh');
  });

  it('passes the AbortSignal through to fetch for quotes', async () => {
    vi.mocked(fetch).mockResolvedValue(json(200, {}));
    const ac = new AbortController();
    await fetchQuote(place, place, 'normal', ac.signal);
    expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).signal).toBe(ac.signal);
  });
});
