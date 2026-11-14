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
import { getPolicy } from '../../config/policy/policy';
import { wsConnections } from '../../metrics';
import { resolveBrowserOrigins } from '../../common/guards/auth-config';
import { RealtimeBus } from './realtime.bus';
import { RealtimeSnapshotService, isUuid } from './realtime-snapshot.service';
import {
  DRIVER_ASSIGNMENT,
  DRIVER_SYNC,
  POOL_SNAPSHOT,
  POOL_SUBSCRIBE,
  RIDE_SNAPSHOT,
  RIDE_SUBSCRIBE,
  type DriverAssignmentSnapshot,
  type PoolSnapshot,
  type RideSnapshot,
  type SubscribeAck,
} from './realtime.protocol';
import type { JwtPayload } from '../../common/guards/auth.guard';
import { verifyAccessToken } from '../../common/guards/access-token';
import type { AcceptOfferResult, DeclineOfferResult } from '../dispatch/dispatch.types';

export const RIDE_OFFER_RESPONSE_EVENT = 'dispatch.ride_offer_response';
export const STOP_CONFIRM_REQUEST_EVENT = 'ride-lifecycle.stop_confirm_request';
/** Emitted once per ride on the driver's first location packet after accept;
 * `module-rides` reacts by applying the implicit `start_en_route` (RCAB-E4.S7). */
export const DRIVER_FIRST_LOCATION_EVENT = 'ride-lifecycle.driver_first_location';
/**
 * Legacy in-process event for `ride:subscribe` (validated + joined by the rides
 * listener). Since R09 the gateway authorizes, joins and snapshots itself and
 * no longer emits it; the constant stays for the listener until its owner
 * removes that handler.
 */
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

let allowedOrigins: string[] | undefined;

/**
 * Same allowlist as REST CORS / CsrfGuard (resolveBrowserOrigins). Resolved lazily so
 * importing this module never throws; main.ts validates the list before listening.
 * Native clients (the driver app) send no Origin header and are always allowed.
 */
export function socketOriginCheck(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) return cb(null, true);
  try {
    allowedOrigins ??= resolveBrowserOrigins();
    cb(null, allowedOrigins.includes(origin));
  } catch {
    cb(null, false);
  }
}

export interface DriverFirstLocationEvent {
  rideId: string;
  driverId: string;
}

/** @deprecated see RIDE_SUBSCRIBE_REQUEST_EVENT. */
export interface RideSubscribeRequestEvent {
  userId: string;
  rideId: string;
}

@WebSocketGateway({ cors: { origin: socketOriginCheck, credentials: true }, transports: ['websocket'] })
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
  // Policy realtime.geoIndexGateMs (3 s) / realtime.locationFanoutMs (1 Hz).
  private readonly geoGateMs = getPolicy().realtime.geoIndexGateMs;
  private readonly fanoutMs = getPolicy().realtime.locationFanoutMs;

  constructor(
    @Inject(JwtService) private jwt: JwtService,
    @Inject(RealtimeBus) private bus: RealtimeBus,
    @Inject(EventEmitter2) private events: EventEmitter2,
    @Inject(REDIS) private redis: Redis,
    @Inject(RealtimeSnapshotService) private snapshots: RealtimeSnapshotService,
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
      wsConnections.inc();
      void client.join(`user:${payload.sub}`);
      if (payload.role === 'driver') {
        void client.join(`driver:${payload.sub}`);
        void this._replayDriverState(client, payload.sub);
        // Every (re)connect re-acquires the committed assignment from Postgres:
        // rooms and Redis projections are never assumed to have survived.
        void this._emitAssignment(client, payload.sub);
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
      if (now - lastFan >= this.fanoutMs) {
        this._fanThrottle.set(currentRideId, now);
        this.bus.toRide(currentRideId, DRIVER_LOCATION_EVENT, {
          rideId: currentRideId,
          lat: data.lat,
          lng: data.lng,
          heading: data.heading,
        });
      }
    }

    // An offline driver (explicit goOffline / sweep deletes driver:state) must not be
    // re-added to the geo index nor get last_seen re-created by a late packet.
    const availability = await this.redis.hget(`driver:state:${driverId}`, 'availability');
    if (!availability || availability === 'offline') return;

    // Geo-index freshness (per-driver, 3 s).
    const lastGeo = this._geoThrottle.get(driverId) ?? 0;
    if (now - lastGeo < this.geoGateMs) return;
    this._geoThrottle.set(driverId, now);
    await Promise.all([
      this.redis.geoadd('active_drivers', data.lng, data.lat, driverId),
      this.redis.hset(`driver:state:${driverId}`, 'last_seen', String(now)),
    ]);
  }

  /**
   * Follow a solo ride: the caller must be its passenger or bound driver
   * (checked against Postgres, not inferred from holding the id). The socket
   * joins `ride:<id>` FIRST, then the snapshot is read and sent, so no
   * transition committed in between can be missed (see realtime.protocol.ts).
   * Clients re-send it on every (re)connect.
   */
  @SubscribeMessage(RIDE_SUBSCRIBE)
  async handleRideSubscribe(
    @MessageBody() data: unknown,
    @ConnectedSocket() client: Socket,
  ): Promise<SubscribeAck<RideSnapshot>> {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: 'forbidden' };
    const rideId = (data as { rideId?: unknown } | null)?.rideId;
    if (!isUuid(rideId)) return { ok: false, reason: 'invalid_payload' };
    try {
      if (!(await this.snapshots.isRideParty(rideId, userId))) {
        this.log.warn({ rideId, userId }, 'ride:subscribe denied — not a party to this ride');
        return { ok: false, reason: 'not_found' };
      }
      await client.join(`ride:${rideId}`);
      const snapshot = await this.snapshots.rideSnapshot(rideId, userId);
      if (!snapshot) {
        await client.leave(`ride:${rideId}`);
        return { ok: false, reason: 'not_found' };
      }
      client.emit(RIDE_SNAPSHOT, snapshot);
      return { ok: true, snapshot };
    } catch (err) {
      this.log.warn({ err, rideId }, 'ride:subscribe failed');
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * Follow a pool: only a passenger holding a `pool_member` row may subscribe.
   * Same join-then-snapshot order as `ride:subscribe`; the socket also joins
   * `ride:<poolId>`, where the claimed driver's position and the trip's
   * `ride:completed` are delivered. Delivery never depends on the server-side
   * `joinPool` made at create time (F10) — the client subscribes after create
   * and on every reconnect.
   */
  @SubscribeMessage(POOL_SUBSCRIBE)
  async handlePoolSubscribe(
    @MessageBody() data: unknown,
    @ConnectedSocket() client: Socket,
  ): Promise<SubscribeAck<PoolSnapshot>> {
    const userId = client.data.userId as string | undefined;
    if (!userId) return { ok: false, reason: 'forbidden' };
    const poolId = (data as { sharedRideId?: unknown } | null)?.sharedRideId;
    if (!isUuid(poolId)) return { ok: false, reason: 'invalid_payload' };
    try {
      if (!(await this.snapshots.isPoolMember(poolId, userId))) {
        this.log.warn({ poolId, userId }, 'pool:subscribe denied — not a member of this pool');
        return { ok: false, reason: 'not_found' };
      }
      await client.join([`pool:${poolId}`, `ride:${poolId}`]);
      const snapshot = await this.snapshots.poolSnapshot(poolId, userId);
      if (!snapshot) {
        await client.leave(`pool:${poolId}`);
        await client.leave(`ride:${poolId}`);
        return { ok: false, reason: 'not_found' };
      }
      client.emit(POOL_SNAPSHOT, snapshot);
      return { ok: true, snapshot };
    } catch (err) {
      this.log.warn({ err, poolId }, 'pool:subscribe failed');
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * Driver asks for its committed assignment (cold start, lost accept ack,
   * listeners attached after the connect-time snapshot). Also emitted as
   * `driver:assignment` so one client code path applies it.
   */
  @SubscribeMessage(DRIVER_SYNC)
  async handleDriverSync(
    @ConnectedSocket() client: Socket,
  ): Promise<DriverAssignmentSnapshot | { ok: false; reason: 'forbidden' | 'unavailable' }> {
    const driverId = client.data.userId as string | undefined;
    if (!driverId || client.data.role !== 'driver') return { ok: false, reason: 'forbidden' };
    const snapshot = await this._emitAssignment(client, driverId);
    return snapshot ?? { ok: false, reason: 'unavailable' };
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
    // Only authenticated sockets were counted on connect (userId is set after verify).
    if (client.data?.userId) wsConnections.dec();
    this.log.debug(`WS disconnected: ${(client.data.userId as string | undefined) ?? 'unknown'}`);
  }

  private async _replayDriverState(client: Socket, driverId: string): Promise<void> {
    const availability = await this.redis.hget(`driver:state:${driverId}`, 'availability');
    if (availability) {
      const currentRideId = await this.redis.hget(`driver:state:${driverId}`, 'current_ride_id');
      client.emit('driver_state', { availability, current_ride_id: currentRideId ?? null });
    }
  }

  private async _emitAssignment(
    client: Socket,
    driverId: string,
  ): Promise<DriverAssignmentSnapshot | null> {
    try {
      const snapshot = await this.snapshots.driverAssignment(driverId);
      client.emit(DRIVER_ASSIGNMENT, snapshot);
      return snapshot;
    } catch (err) {
      this.log.warn({ err, driverId }, 'driver assignment snapshot failed');
      return null;
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
