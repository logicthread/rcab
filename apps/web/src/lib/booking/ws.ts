import { io, type Socket } from 'socket.io-client';
import type {
  DriverLocationEvent,
  PoolSnapshotEvent,
  PoolUpdateEvent,
  RideSnapshotEvent,
  RideStateChangedEvent,
} from './types';

const WS_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
export const POOL_UPDATE_EVENT = 'pool:update';
export const POOL_SNAPSHOT_EVENT = 'pool:snapshot';
export const POOL_SUBSCRIBE_EVENT = 'pool:subscribe';
export const DRIVER_LOCATION_EVENT = 'driver_location';
export const RIDE_STATE_CHANGED_EVENT = 'ride_state_changed';
export const RIDE_SNAPSHOT_EVENT = 'ride:snapshot';
export const RIDE_SUBSCRIBE_EVENT = 'ride:subscribe';
/** Emitted to `ride:<poolId>` when the driver confirms a pool's final stop. */
export const RIDE_COMPLETED_EVENT = 'ride:completed';

// Mirrors the api's `rideStatusVersion` (realtime.protocol.ts): a forward-only
// rank, terminal statuses at the top. Used for legacy events without `version`.
const RIDE_STATUS_RANK: Record<string, number> = {
  requested: 1,
  dispatching: 2,
  accepted: 3,
  en_route: 4,
  arrived: 5,
  in_progress: 6,
  completed: 10,
  cancelled: 10,
  no_driver: 10,
  no_show: 10,
};

export function rideStatusVersion(status: string): number {
  return RIDE_STATUS_RANK[status] ?? 0;
}

/**
 * Per-aggregate ordering gate (R09). A snapshot is authoritative and applies
 * when its version is >= the last applied one; an incremental event applies
 * only when strictly newer. Anything for another aggregate is dropped, so a
 * late event from a previous trip cannot leak into the current one.
 */
export interface VersionGate {
  /** Follow a new aggregate (forgets the previous one's version). */
  follow(id: string): void;
  current(): string | null;
  snapshot(id: string, version: number): boolean;
  event(id: string, version: number | undefined): boolean;
}

export function createVersionGate(): VersionGate {
  let followed: string | null = null;
  let applied = Number.NEGATIVE_INFINITY;
  return {
    follow(id) {
      if (id === followed) return;
      followed = id;
      applied = Number.NEGATIVE_INFINITY;
    },
    current() {
      return followed;
    },
    snapshot(id, version) {
      if (id !== followed || !Number.isFinite(version) || version < applied) return false;
      applied = version;
      return true;
    },
    event(id, version) {
      if (id !== followed) return false;
      // Unversioned (pre-R09 server): cannot be ordered, pass it through.
      if (version === undefined || !Number.isFinite(version)) return true;
      if (version <= applied) return false;
      applied = version;
      return true;
    },
  };
}

export interface BookingSocket {
  socket: Socket;
  /**
   * Versioned pool state for the subscribed pool: every applied `pool:snapshot`
   * and every `pool:update` newer than it. Stale / duplicate / foreign events
   * never reach the handler.
   */
  onPoolUpdate(handler: (payload: PoolUpdateEvent) => void): () => void;
  /** The full member snapshot (fare, own stops), after the version gate. */
  onPoolSnapshot(handler: (payload: PoolSnapshotEvent) => void): () => void;
  onDriverLocation(handler: (payload: DriverLocationEvent) => void): () => void;
  /** Solo ride status: `ride:snapshot` + newer `ride_state_changed` only. */
  onRideStateChanged(handler: (payload: RideStateChangedEvent) => void): () => void;
  /**
   * Follow `pool:<id>`: the server checks membership, joins the socket and
   * returns a snapshot. Re-sent on EVERY (re)connect — rooms never survive a
   * reconnect and the create-time server join is not relied on (F10).
   */
  subscribePool(sharedRideId: string): void;
  /** Same for a solo ride (`ride:<id>`), re-sent on every (re)connect. */
  subscribeRide(rideId: string): void;
  close(): void;
}

/** Resolves a currently-valid access token (refreshing if needed), or null. */
export type TokenProvider = () => Promise<string | null>;

type Handler<T> = (payload: T) => void;

export function connectBookingSocket(getToken: TokenProvider): BookingSocket {
  const socket = io(WS_BASE, {
    transports: ['websocket'],
    // Callback form: socket.io evaluates it on every (re)connect, so a reconnect
    // after the access token lapsed authenticates with a fresh one.
    auth: (cb) => {
      getToken().then(
        (token) => cb({ token: token ?? '' }),
        () => cb({ token: '' }),
      );
    },
    reconnection: true,
    reconnectionDelayMax: 5_000,
  });

  const poolGate = createVersionGate();
  const rideGate = createVersionGate();
  const poolHandlers = new Set<Handler<PoolUpdateEvent>>();
  const poolSnapshotHandlers = new Set<Handler<PoolSnapshotEvent>>();
  const rideHandlers = new Set<Handler<RideStateChangedEvent>>();

  const subscribePoolNow = () => {
    const id = poolGate.current();
    if (id) socket.emit(POOL_SUBSCRIBE_EVENT, { sharedRideId: id });
  };
  const subscribeRideNow = () => {
    const id = rideGate.current();
    if (id) socket.emit(RIDE_SUBSCRIBE_EVENT, { rideId: id });
  };

  // One listener per server event; the gates decide what reaches the app.
  socket.on(POOL_SNAPSHOT_EVENT, (snap: PoolSnapshotEvent) => {
    if (!snap || !poolGate.snapshot(snap.sharedRideId, snap.version)) return;
    for (const h of poolHandlers) h(snap);
    for (const h of poolSnapshotHandlers) h(snap);
  });
  socket.on(POOL_UPDATE_EVENT, (update: PoolUpdateEvent) => {
    if (!update || !poolGate.event(update.sharedRideId, update.version)) return;
    for (const h of poolHandlers) h(update);
  });
  socket.on(RIDE_SNAPSHOT_EVENT, (snap: RideSnapshotEvent) => {
    if (!snap || !rideGate.snapshot(snap.rideId, snap.version)) return;
    const asEvent: RideStateChangedEvent = {
      rideId: snap.rideId,
      state: snap.status,
      by: 'snapshot',
      version: snap.version,
    };
    for (const h of rideHandlers) h(asEvent);
  });
  socket.on(RIDE_STATE_CHANGED_EVENT, (ev: RideStateChangedEvent) => {
    if (!ev) return;
    const version = ev.version ?? rideStatusVersion(ev.state);
    if (!rideGate.event(ev.rideId, version)) return;
    for (const h of rideHandlers) h(ev);
  });
  // The pool's completion is announced on `ride:<poolId>` without a pool
  // version: reconcile from a fresh authoritative snapshot instead of guessing.
  socket.on(RIDE_COMPLETED_EVENT, (ev: { rideId?: string }) => {
    if (ev && ev.rideId && ev.rideId === poolGate.current()) subscribePoolNow();
  });
  socket.on('connect', () => {
    subscribePoolNow();
    subscribeRideNow();
  });

  function on<T>(event: string, handler: (payload: T) => void): () => void {
    const wrapped = (payload: T) => handler(payload);
    socket.on(event, wrapped);
    return () => {
      socket.off(event, wrapped);
    };
  }

  function add<T>(set: Set<Handler<T>>, handler: Handler<T>): () => void {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  return {
    socket,
    onPoolUpdate(handler) {
      return add(poolHandlers, handler);
    },
    onPoolSnapshot(handler) {
      return add(poolSnapshotHandlers, handler);
    },
    onDriverLocation(handler) {
      return on<DriverLocationEvent>(DRIVER_LOCATION_EVENT, handler);
    },
    onRideStateChanged(handler) {
      return add(rideHandlers, handler);
    },
    subscribePool(sharedRideId) {
      poolGate.follow(sharedRideId);
      if (socket.connected) subscribePoolNow();
    },
    subscribeRide(rideId) {
      rideGate.follow(rideId);
      if (socket.connected) subscribeRideNow();
    },
    close() {
      poolHandlers.clear();
      poolSnapshotHandlers.clear();
      rideHandlers.clear();
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
