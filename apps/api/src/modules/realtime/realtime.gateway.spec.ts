import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeGateway } from './realtime.gateway';
import { JwtService } from '@nestjs/jwt';
import { RealtimeBus } from './realtime.bus';
import type { Socket } from 'socket.io';

const DRIVER_ID = 'driver-uuid-1';

// ── Mocks ─────────────────────────────────────────────────────────────────────

function buildRedis() {
  return {
    geoadd: vi.fn().mockResolvedValue(1),
    hset: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    duplicate: vi.fn().mockReturnThis(),
  };
}

function buildJwt() {
  return { verify: vi.fn() } as unknown as JwtService;
}

function buildBus() {
  return { setServer: vi.fn(), toDriver: vi.fn() } as unknown as RealtimeBus;
}

function makeSocket(overrides: { userId?: string; role?: string } = {}): Socket {
  return {
    data: { userId: overrides.userId ?? DRIVER_ID, role: overrides.role ?? 'driver' },
    emit: vi.fn(),
    join: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    handshake: { auth: {}, headers: {} },
  } as unknown as Socket;
}

const LOCATION = { lat: 1.3, lng: 103.8, heading: 45, speed: 30 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RealtimeGateway — driver:location handler', () => {
  let gateway: RealtimeGateway;
  let redis: ReturnType<typeof buildRedis>;

  beforeEach(() => {
    vi.useFakeTimers();
    redis = buildRedis();
    gateway = new RealtimeGateway(buildJwt(), buildBus(), redis as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls GEOADD with (lng, lat, driverId) on first accepted event', async () => {
    const client = makeSocket();
    await gateway.handleDriverLocation(LOCATION, client);

    expect(redis.geoadd).toHaveBeenCalledOnce();
    expect(redis.geoadd).toHaveBeenCalledWith(
      'active_drivers',
      LOCATION.lng,
      LOCATION.lat,
      DRIVER_ID,
    );
  });

  it('updates last_seen HSET on accepted event', async () => {
    const client = makeSocket();
    await gateway.handleDriverLocation(LOCATION, client);

    expect(redis.hset).toHaveBeenCalledOnce();
    expect(redis.hset).toHaveBeenCalledWith(
      `driver:state:${DRIVER_ID}`,
      'last_seen',
      expect.any(String),
    );
  });

  it('drops a second event within 3 s (throttle)', async () => {
    const client = makeSocket();
    await gateway.handleDriverLocation(LOCATION, client);

    vi.advanceTimersByTime(2000);
    await gateway.handleDriverLocation({ ...LOCATION, lat: 1.31 }, client);

    expect(redis.geoadd).toHaveBeenCalledOnce();
  });

  it('accepts an event after 3 s have elapsed', async () => {
    const client = makeSocket();
    await gateway.handleDriverLocation(LOCATION, client);

    vi.advanceTimersByTime(3001);
    const newLoc = { ...LOCATION, lat: 1.31, lng: 103.81 };
    await gateway.handleDriverLocation(newLoc, client);

    expect(redis.geoadd).toHaveBeenCalledTimes(2);
    expect(redis.geoadd).toHaveBeenLastCalledWith(
      'active_drivers',
      newLoc.lng,
      newLoc.lat,
      DRIVER_ID,
    );
  });

  it('ignores events from non-driver sockets', async () => {
    const client = makeSocket({ role: 'client' });
    await gateway.handleDriverLocation(LOCATION, client);

    expect(redis.geoadd).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway — handleConnection reconnect state replay', () => {
  let gateway: RealtimeGateway;
  let redis: ReturnType<typeof buildRedis>;
  let jwt: JwtService;

  beforeEach(() => {
    redis = buildRedis();
    jwt = buildJwt();
    gateway = new RealtimeGateway(jwt, buildBus(), redis as never);
  });

  it('emits driver_state when driver:state:<id> exists in Redis', async () => {
    redis.hget
      .mockResolvedValueOnce('online')   // availability
      .mockResolvedValueOnce(null);      // current_ride_id

    (jwt.verify as ReturnType<typeof vi.fn>).mockReturnValue({
      sub: DRIVER_ID,
      role: 'driver',
    });

    const client = makeSocket();
    (client.handshake as unknown as Record<string, unknown>).auth = { token: 'tok' };

    gateway.handleConnection(client);
    // _replayDriverState is async; let microtasks flush
    await Promise.resolve();
    await Promise.resolve();

    expect(client.emit).toHaveBeenCalledWith('driver_state', {
      availability: 'online',
      current_ride_id: null,
    });
  });

  it('does NOT emit driver_state when no Redis hash exists', async () => {
    redis.hget.mockResolvedValue(null);

    (jwt.verify as ReturnType<typeof vi.fn>).mockReturnValue({
      sub: DRIVER_ID,
      role: 'driver',
    });

    const client = makeSocket();
    (client.handshake as unknown as Record<string, unknown>).auth = { token: 'tok' };

    gateway.handleConnection(client);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.emit).not.toHaveBeenCalled();
  });
});
