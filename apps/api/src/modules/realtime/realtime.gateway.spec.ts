import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RealtimeGateway,
  RIDE_OFFER_RESPONSE_EVENT,
  STOP_CONFIRM_REQUEST_EVENT,
  DRIVER_FIRST_LOCATION_EVENT,
  RIDE_SUBSCRIBE_REQUEST_EVENT,
} from './realtime.gateway';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
  return {
    setServer: vi.fn(),
    toDriver: vi.fn(),
    toRide: vi.fn(),
    joinRide: vi.fn().mockResolvedValue(undefined),
  } as unknown as RealtimeBus;
}

function buildEvents() {
  return new EventEmitter2();
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
    gateway = new RealtimeGateway(buildJwt(), buildBus(), buildEvents(), redis as never);
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

describe('RealtimeGateway — ride_offer_response handler', () => {
  let gateway: RealtimeGateway;
  let events: EventEmitter2;

  beforeEach(() => {
    events = new EventEmitter2();
    gateway = new RealtimeGateway(buildJwt(), buildBus(), events, buildRedis() as never);
  });

  it('emits dispatch.ride_offer_response with driverId from socket data', () => {
    const seen = vi.fn();
    events.on(RIDE_OFFER_RESPONSE_EVENT, seen);
    const client = makeSocket();

    gateway.handleRideOfferResponse(
      { offerId: 'offer-1', sharedRideId: 'pool-1', accept: true },
      client,
    );

    expect(seen).toHaveBeenCalledWith({
      driverId: DRIVER_ID,
      offerId: 'offer-1',
      sharedRideId: 'pool-1',
      accept: true,
    });
  });

  it('ignores responses from non-driver sockets', () => {
    const seen = vi.fn();
    events.on(RIDE_OFFER_RESPONSE_EVENT, seen);
    const client = makeSocket({ role: 'client' });

    gateway.handleRideOfferResponse({ offerId: 'offer-2', accept: true }, client);

    expect(seen).not.toHaveBeenCalled();
  });

  it('ignores malformed payloads', () => {
    const seen = vi.fn();
    events.on(RIDE_OFFER_RESPONSE_EVENT, seen);
    const client = makeSocket();

    gateway.handleRideOfferResponse(
      { offerId: 123 } as unknown as { offerId: string; accept: boolean },
      client,
    );

    expect(seen).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway — stop confirm handlers', () => {
  let gateway: RealtimeGateway;
  let events: EventEmitter2;

  beforeEach(() => {
    events = new EventEmitter2();
    gateway = new RealtimeGateway(buildJwt(), buildBus(), events, buildRedis() as never);
  });

  it('emits STOP_CONFIRM_REQUEST_EVENT with type=pickup on stop:pickup_confirmed', () => {
    const seen = vi.fn();
    events.on(STOP_CONFIRM_REQUEST_EVENT, seen);
    gateway.handleStopPickupConfirmed({ rideId: 'r-1', sequenceIndex: 0 }, makeSocket());
    expect(seen).toHaveBeenCalledWith({
      driverId: DRIVER_ID,
      rideId: 'r-1',
      sequenceIndex: 0,
      type: 'pickup',
    });
  });

  it('emits STOP_CONFIRM_REQUEST_EVENT with type=dropoff on stop:drop_confirmed', () => {
    const seen = vi.fn();
    events.on(STOP_CONFIRM_REQUEST_EVENT, seen);
    gateway.handleStopDropConfirmed({ rideId: 'r-2', sequenceIndex: 3 }, makeSocket());
    expect(seen).toHaveBeenCalledWith({
      driverId: DRIVER_ID,
      rideId: 'r-2',
      sequenceIndex: 3,
      type: 'dropoff',
    });
  });

  it('ignores non-driver sockets', () => {
    const seen = vi.fn();
    events.on(STOP_CONFIRM_REQUEST_EVENT, seen);
    gateway.handleStopPickupConfirmed(
      { rideId: 'r-1', sequenceIndex: 0 },
      makeSocket({ role: 'client' }),
    );
    expect(seen).not.toHaveBeenCalled();
  });

  it('ignores malformed sequenceIndex', () => {
    const seen = vi.fn();
    events.on(STOP_CONFIRM_REQUEST_EVENT, seen);
    gateway.handleStopDropConfirmed(
      { rideId: 'r-1', sequenceIndex: 1.5 } as unknown as { rideId: string; sequenceIndex: number },
      makeSocket(),
    );
    expect(seen).not.toHaveBeenCalled();
  });

  it('ignores missing rideId', () => {
    const seen = vi.fn();
    events.on(STOP_CONFIRM_REQUEST_EVENT, seen);
    gateway.handleStopPickupConfirmed(
      { sequenceIndex: 0 } as unknown as { rideId: string; sequenceIndex: number },
      makeSocket(),
    );
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway — handleConnection reconnect state replay', () => {
  let gateway: RealtimeGateway;
  let redis: ReturnType<typeof buildRedis>;
  let jwt: JwtService;

  beforeEach(() => {
    redis = buildRedis();
    jwt = buildJwt();
    gateway = new RealtimeGateway(jwt, buildBus(), buildEvents(), redis as never);
  });

  it('emits driver_state when driver:state:<id> exists in Redis', async () => {
    redis.hget
      .mockResolvedValueOnce('online') // availability
      .mockResolvedValueOnce(null); // current_ride_id

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

const RIDE_ID = 'ride-uuid-1';

describe('RealtimeGateway — driver_location fan-out', () => {
  let gateway: RealtimeGateway;
  let redis: ReturnType<typeof buildRedis>;
  let bus: RealtimeBus;

  beforeEach(() => {
    vi.useFakeTimers();
    redis = buildRedis();
    redis.hget.mockResolvedValue(RIDE_ID); // driver is on an active ride
    bus = buildBus();
    gateway = new RealtimeGateway(buildJwt(), bus, buildEvents(), redis as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fans the location out to the ride room with a camelCase payload', async () => {
    await gateway.handleDriverLocation(LOCATION, makeSocket());
    expect(bus.toRide).toHaveBeenCalledWith(RIDE_ID, 'driver_location', {
      rideId: RIDE_ID,
      lat: LOCATION.lat,
      lng: LOCATION.lng,
      heading: LOCATION.heading,
    });
  });

  it('rate-limits fan-out to 1 Hz per ride', async () => {
    const client = makeSocket();
    await gateway.handleDriverLocation(LOCATION, client);
    vi.advanceTimersByTime(500);
    await gateway.handleDriverLocation({ ...LOCATION, lat: 1.31 }, client);
    expect(bus.toRide).toHaveBeenCalledOnce();
  });

  it('fans out again once a second has elapsed', async () => {
    const client = makeSocket();
    await gateway.handleDriverLocation(LOCATION, client);
    vi.advanceTimersByTime(1001);
    await gateway.handleDriverLocation({ ...LOCATION, lat: 1.31 }, client);
    expect(bus.toRide).toHaveBeenCalledTimes(2);
  });

  it('does NOT fan out when the driver is not on a ride', async () => {
    redis.hget.mockResolvedValue(null);
    await gateway.handleDriverLocation(LOCATION, makeSocket());
    expect(bus.toRide).not.toHaveBeenCalled();
  });

  it('still updates the geo-index while on a ride', async () => {
    await gateway.handleDriverLocation(LOCATION, makeSocket());
    expect(redis.geoadd).toHaveBeenCalledWith(
      'active_drivers',
      LOCATION.lng,
      LOCATION.lat,
      DRIVER_ID,
    );
  });
});

describe('RealtimeGateway — implicit start_en_route on first location', () => {
  let gateway: RealtimeGateway;
  let events: EventEmitter2;
  let redis: ReturnType<typeof buildRedis>;

  beforeEach(() => {
    events = new EventEmitter2();
    redis = buildRedis();
    redis.hget.mockResolvedValue(RIDE_ID);
    gateway = new RealtimeGateway(buildJwt(), buildBus(), events, redis as never);
  });

  it('emits DRIVER_FIRST_LOCATION_EVENT once for the ride', async () => {
    const seen = vi.fn();
    events.on(DRIVER_FIRST_LOCATION_EVENT, seen);
    const client = makeSocket();

    await gateway.handleDriverLocation(LOCATION, client);
    await gateway.handleDriverLocation({ ...LOCATION, lat: 1.31 }, client);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ rideId: RIDE_ID, driverId: DRIVER_ID });
  });

  it('does not emit when the driver is not on a ride', async () => {
    redis.hget.mockResolvedValue(null);
    const seen = vi.fn();
    events.on(DRIVER_FIRST_LOCATION_EVENT, seen);
    await gateway.handleDriverLocation(LOCATION, makeSocket());
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway — ride:subscribe handler', () => {
  let gateway: RealtimeGateway;
  let events: EventEmitter2;

  beforeEach(() => {
    events = new EventEmitter2();
    gateway = new RealtimeGateway(buildJwt(), buildBus(), events, buildRedis() as never);
  });

  it('emits RIDE_SUBSCRIBE_REQUEST_EVENT with userId from socket data', () => {
    const seen = vi.fn();
    events.on(RIDE_SUBSCRIBE_REQUEST_EVENT, seen);
    gateway.handleRideSubscribe(
      { rideId: RIDE_ID },
      makeSocket({ userId: 'client-1', role: 'client' }),
    );
    expect(seen).toHaveBeenCalledWith({ userId: 'client-1', rideId: RIDE_ID });
  });

  it('ignores a malformed payload', () => {
    const seen = vi.fn();
    events.on(RIDE_SUBSCRIBE_REQUEST_EVENT, seen);
    gateway.handleRideSubscribe({} as { rideId?: string }, makeSocket());
    expect(seen).not.toHaveBeenCalled();
  });
});
