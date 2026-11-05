import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { RealtimeBus } from './realtime.bus';
import type { JwtPayload } from '../../common/guards/auth.guard';
import { verifyAccessToken } from '../../common/guards/access-token';
import type { AcceptOfferResult, DeclineOfferResult } from '../dispatch/dispatch.types';

export const RIDE_OFFER_RESPONSE_EVENT = 'dispatch.ride_offer_response';
export const STOP_CONFIRM_REQUEST_EVENT = 'ride-lifecycle.stop_confirm_request';
/** Emitted once per ride on the driver's first location packet after accept;
 * `module-rides` reacts by applying the implicit `start_en_route` (RCAB-E4.S7). */
export const DRIVER_FIRST_LOCATION_EVENT = 'ride-lifecycle.driver_first_location';
/** Client asks to (re)join its ride room; `module-rides` validates ownership
 * then `joinRide`s the socket. Used by the web rider on create + reconnect. */
export const RIDE_SUBSCRIBE_REQUEST_EVENT = 'realtime.ride_subscribe_request';
/** Server → client live driver position while a ride is active. */
export const DRIVER_LOCATION_EVENT = 'driver_location';

/**
 * Driver → server answer to a `ride_offer`. Only `offerId` (a UUID) and a
 * strict boolean `accept` are read; any client-sent trip id (the legacy
 * `sharedRideId`) is ignored — the trip comes from the stored offer (F05).
 */
export interface RideOfferResponsePayload {
  offerId: string;
  accept: boolean;
}

export interface RideOfferResponseEvent extends RideOfferResponsePayload {
  driverId: string;
}

/** The Socket.IO ack for `ride_offer_response`. */
export type RideOfferResponseAck =
  | AcceptOfferResult
  | DeclineOfferResult
  | { ok: false; reason: 'invalid_payload' | 'forbidden' | 'unavailable' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LocationPayload {
  lat: number;
  lng: number;
  heading: number;
  speed: number;
}

interface StopConfirmPayload {
  rideId: string;
  sequenceIndex: number;
}

export interface StopConfirmRequestEvent {
  rideId: string;
  driverId: string;
  sequenceIndex: number;
  type: 'pickup' | 'dropoff';
}

export interface DriverFirstLocationEvent {
  rideId: string;
  driverId: string;
}

export interface RideSubscribeRequestEvent {
  userId: string;
  rideId: string;
}

@WebSocketGateway({ cors: { origin: '*' }, transports: ['websocket'] })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly log = new Logger(RealtimeGateway.name);
  private _adapterPub?: Redis;
  private _adapterSub?: Redis;
  // Geo-index freshness gate (per-driver). Independent of the fan-out gate.
  private readonly _geoThrottle = new Map<string, number>();
  // Client fan-out gate (per-ride) — the smooth-dot 1 Hz debouncer.
  private readonly _fanThrottle = new Map<string, number>();
  // Rides whose first post-accept location packet already kicked the implicit
  // `start_en_route`. Bounded by distinct rides served by this node; Phase-0
  // volume makes pruning unnecessary.
  private readonly _enRouteFired = new Set<string>();
  private static readonly GEO_THROTTLE_MS = 3000;
  private static readonly FAN_THROTTLE_MS = 1000;

  constructor(
    @Inject(JwtService) private jwt: JwtService,
    @Inject(RealtimeBus) private bus: RealtimeBus,
    @Inject(EventEmitter2) private events: EventEmitter2,
    @Inject(REDIS) private redis: Redis,
  ) {}

  afterInit(server: Server): void {
    // Wire the Redis scale-out adapter for multi-node pub/sub. At single node it
    // is effectively a no-op; when the injected client can't duplicate (e.g. a
    // lightweight test stub), skip it and fall back to the default in-memory
    // adapter rather than crashing init.
    const redis = this.redis as Partial<Redis>;
    if (typeof redis.duplicate === 'function' && process.env.RCAB_DISABLE_WS_ADAPTER !== '1') {
      const pub = redis.duplicate();
      const sub = redis.duplicate();
      this._adapterPub = pub;
      this._adapterSub = sub;
      pub.on('error', (err) => this.log.warn(`adapter pub error: ${err.message}`));
      sub.on('error', (err) => this.log.warn(`adapter sub error: ${err.message}`));
      server.adapter(createAdapter(pub, sub));
    }
    this.bus.setServer(server);
    this.log.log('RealtimeGateway initialised');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this._adapterPub?.quit(),
      this._adapterSub?.quit(),
    ]);
    this._adapterPub = undefined;
    this._adapterSub = undefined;
  }

  handleConnection(client: Socket): void {
    const token = this._extractToken(client);
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload: JwtPayload = verifyAccessToken(this.jwt, token);
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      void client.join(`user:${payload.sub}`);
      if (payload.role === 'driver') {
        void client.join(`driver:${payload.sub}`);
        void this._replayDriverState(client, payload.sub);
      }
      this.log.debug(`WS connected: ${payload.sub} (${payload.role})`);
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('driver:location')
  async handleDriverLocation(
    @MessageBody() data: LocationPayload,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const driverId = client.data.userId as string | undefined;
    if (!driverId || client.data.role !== 'driver') return;

    const now = Date.now();

    // Live-ride fan-out — independent of the geo-index gate below. While the
    // driver is bound to a ride, mirror their position to the ride's client
    // room at ≤ 1 Hz, and kick the implicit `start_en_route` on the first packet.
    const currentRideId = await this.redis.hget(`driver:state:${driverId}`, 'current_ride_id');
    if (currentRideId) {
      if (!this._enRouteFired.has(currentRideId)) {
        this._enRouteFired.add(currentRideId);
        this.events.emit(DRIVER_FIRST_LOCATION_EVENT, {
          rideId: currentRideId,
          driverId,
        } satisfies DriverFirstLocationEvent);
      }
      const lastFan = this._fanThrottle.get(currentRideId) ?? 0;
      if (now - lastFan >= RealtimeGateway.FAN_THROTTLE_MS) {
        this._fanThrottle.set(currentRideId, now);
        this.bus.toRide(currentRideId, DRIVER_LOCATION_EVENT, {
          rideId: currentRideId,
          lat: data.lat,
          lng: data.lng,
          heading: data.heading,
        });
      }
    }

    // Geo-index freshness (per-driver, 3 s).
    const lastGeo = this._geoThrottle.get(driverId) ?? 0;
    if (now - lastGeo < RealtimeGateway.GEO_THROTTLE_MS) return;
    this._geoThrottle.set(driverId, now);
    await Promise.all([
      this.redis.geoadd('active_drivers', data.lng, data.lat, driverId),
      this.redis.hset(`driver:state:${driverId}`, 'last_seen', String(now)),
    ]);
  }

  @SubscribeMessage('ride:subscribe')
  handleRideSubscribe(
    @MessageBody() data: { rideId?: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
    if (!data || typeof data.rideId !== 'string') return;

    // Ownership is validated by the rides listener before the socket is joined.
    this.events.emit(RIDE_SUBSCRIBE_REQUEST_EVENT, {
      userId,
      rideId: data.rideId,
    } satisfies RideSubscribeRequestEvent);
  }

  /**
   * Accept / decline an offer. Rejects anything but a UUID `offerId` and a
   * real boolean `accept` (`'false'`, `1`, … are not coerced). Dispatch answers
   * through `emitAsync`, and its result is returned as the Socket.IO ack —
   * keeping the realtime → dispatch module cycle broken.
   */
  @SubscribeMessage('ride_offer_response')
  async handleRideOfferResponse(
    @MessageBody() data: unknown,
    @ConnectedSocket() client: Socket,
  ): Promise<RideOfferResponseAck> {
    const driverId = client.data.userId as string | undefined;
    if (!driverId || client.data.role !== 'driver') return { ok: false, reason: 'forbidden' };
    if (!data || typeof data !== 'object') return { ok: false, reason: 'invalid_payload' };
    const { offerId, accept } = data as Record<string, unknown>;
    if (typeof offerId !== 'string' || !UUID_RE.test(offerId) || typeof accept !== 'boolean') {
      return { ok: false, reason: 'invalid_payload' };
    }

    const results: unknown[] = await this.events.emitAsync(RIDE_OFFER_RESPONSE_EVENT, {
      driverId,
      offerId,
      accept,
    } satisfies RideOfferResponseEvent);
    const answer = results.find((r) => r !== undefined) as RideOfferResponseAck | undefined;
    return answer ?? { ok: false, reason: 'unavailable' };
  }

  @SubscribeMessage('stop:pickup_confirmed')
  handleStopPickupConfirmed(
    @MessageBody() data: StopConfirmPayload,
    @ConnectedSocket() client: Socket,
  ): void {
    this._emitStopConfirm(data, client, 'pickup');
  }

  @SubscribeMessage('stop:drop_confirmed')
  handleStopDropConfirmed(
    @MessageBody() data: StopConfirmPayload,
    @ConnectedSocket() client: Socket,
  ): void {
    this._emitStopConfirm(data, client, 'dropoff');
  }

  private _emitStopConfirm(
    data: StopConfirmPayload,
    client: Socket,
    type: 'pickup' | 'dropoff',
  ): void {
    const driverId = client.data.userId as string | undefined;
    if (!driverId || client.data.role !== 'driver') return;
    if (!data || typeof data.rideId !== 'string') return;
    if (typeof data.sequenceIndex !== 'number' || !Number.isInteger(data.sequenceIndex)) return;

    this.events.emit(STOP_CONFIRM_REQUEST_EVENT, {
      driverId,
      rideId: data.rideId,
      sequenceIndex: data.sequenceIndex,
      type,
    } satisfies StopConfirmRequestEvent);
  }

  handleDisconnect(client: Socket): void {
    this.log.debug(`WS disconnected: ${(client.data.userId as string | undefined) ?? 'unknown'}`);
  }

  private async _replayDriverState(client: Socket, driverId: string): Promise<void> {
    const availability = await this.redis.hget(`driver:state:${driverId}`, 'availability');
    if (availability) {
      const currentRideId = await this.redis.hget(`driver:state:${driverId}`, 'current_ride_id');
      client.emit('driver_state', { availability, current_ride_id: currentRideId ?? null });
    }
  }

  private _extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown>;
    if (typeof auth['token'] === 'string') return auth['token'];
    const header = client.handshake.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    return null;
  }
}
