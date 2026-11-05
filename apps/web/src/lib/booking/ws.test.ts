import { describe, it, expect, vi, beforeEach } from 'vitest';

const ioMock = vi.fn();
vi.mock('socket.io-client', () => ({ io: (...a: unknown[]) => ioMock(...a) }));

import { connectBookingSocket } from './ws';

describe('connectBookingSocket auth (F18c)', () => {
  beforeEach(() => {
    ioMock.mockReset();
    ioMock.mockReturnValue({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false });
  });

  it('supplies auth as a callback evaluated per (re)connect with a fresh token', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('tok-1').mockResolvedValueOnce('tok-2');
    connectBookingSocket(getToken);
    const opts = ioMock.mock.calls[0][1] as { auth: (cb: (d: unknown) => void) => void };
    expect(typeof opts.auth).toBe('function');

    const first = vi.fn();
    opts.auth(first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ token: 'tok-1' }));

    const second = vi.fn(); // simulated reconnect
    opts.auth(second);
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith({ token: 'tok-2' }));
  });

  it('sends an empty token (server rejects) when no token can be obtained', async () => {
    connectBookingSocket(() => Promise.resolve(null));
    const opts = ioMock.mock.calls[0][1] as { auth: (cb: (d: unknown) => void) => void };
    const cb = vi.fn();
    opts.auth(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith({ token: '' }));
  });
});
