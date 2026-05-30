import { io, type Socket } from 'socket.io-client';
import type { DriverLocationEvent, PoolUpdateEvent, RideStateChangedEvent } from './types';

const WS_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
export const POOL_UPDATE_EVENT = 'pool:update';
export const DRIVER_LOCATION_EVENT = 'driver_location';
export const RIDE_STATE_CHANGED_EVENT = 'ride_state_changed';
export const RIDE_SUBSCRIBE_EVENT = 'ride:subscribe';

export interface BookingSocket {
  socket: Socket;
  onPoolUpdate(handler: (payload: PoolUpdateEvent) => void): () => void;
  onDriverLocation(handler: (payload: DriverLocationEvent) => void): () => void;
  onRideStateChanged(handler: (payload: RideStateChangedEvent) => void): () => void;
  /** Ask the server to (re)join this socket to `ride:<id>`. Re-emitted on every
   * (re)connect so a dropped connection or a full page reload re-subscribes. */
  subscribeRide(rideId: string): void;
  close(): void;
}

export function connectBookingSocket(jwt: string): BookingSocket {
  const socket = io(WS_BASE, {
    transports: ['websocket'],
    auth: { token: jwt },
    reconnection: true,
    reconnectionDelayMax: 5_000,
  });

  function on<T>(event: string, handler: (payload: T) => void): () => void {
    const wrapped = (payload: T) => handler(payload);
    socket.on(event, wrapped);
    return () => {
      socket.off(event, wrapped);
    };
  }

  return {
    socket,
    onPoolUpdate(handler) {
      return on<PoolUpdateEvent>(POOL_UPDATE_EVENT, handler);
    },
    onDriverLocation(handler) {
      return on<DriverLocationEvent>(DRIVER_LOCATION_EVENT, handler);
    },
    onRideStateChanged(handler) {
      return on<RideStateChangedEvent>(RIDE_STATE_CHANGED_EVENT, handler);
    },
    subscribeRide(rideId) {
      const join = () => socket.emit(RIDE_SUBSCRIBE_EVENT, { rideId });
      socket.on('connect', join);
      if (socket.connected) join();
    },
    close() {
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
