import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RealtimeBus } from './realtime.bus';
import type { Server } from 'socket.io';

function buildServer() {
  const emit = vi.fn();
  const socketsJoin = vi.fn().mockResolvedValue(undefined);
  const to = vi.fn().mockReturnValue({ emit });
  const inFn = vi.fn().mockReturnValue({ socketsJoin });
  return { to, in: inFn, emit, socketsJoin } as unknown as Server & {
    emit: typeof emit;
    socketsJoin: typeof socketsJoin;
  };
}

describe('RealtimeBus', () => {
  let bus: RealtimeBus;
  let server: ReturnType<typeof buildServer>;

  beforeEach(() => {
    bus = new RealtimeBus();
    server = buildServer();
    bus.setServer(server);
  });

  it('throws if used before setServer', () => {
    const fresh = new RealtimeBus();
    expect(() => fresh.toUser('u', 'evt', {})).toThrow(/not initialised/);
  });

  it('toPool emits to pool:<rideId> room', () => {
    bus.toPool('ride-1', 'pool:update', { x: 1 });
    expect(server.to).toHaveBeenCalledWith('pool:ride-1');
  });

  it('joinPool moves sockets in user:<userId> into pool:<rideId>', async () => {
    await bus.joinPool('user-1', 'ride-1');
    expect(server.in).toHaveBeenCalledWith('user:user-1');
    expect(server.socketsJoin).toHaveBeenCalledWith('pool:ride-1');
  });

  it('joinPool swallows socketsJoin failures', async () => {
    server.socketsJoin.mockRejectedValueOnce(new Error('adapter down'));
    await expect(bus.joinPool('u', 'r')).resolves.toBeUndefined();
  });
});
