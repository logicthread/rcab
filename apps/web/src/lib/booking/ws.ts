import { io, type Socket } from 'socket.io-client';
import type { PoolUpdateEvent } from './types';

const WS_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
export const POOL_UPDATE_EVENT = 'pool:update';

export interface BookingSocket {
  socket: Socket;
  onPoolUpdate(handler: (payload: PoolUpdateEvent) => void): () => void;
  close(): void;
}

export function connectBookingSocket(jwt: string): BookingSocket {
  const socket = io(WS_BASE, {
    transports: ['websocket'],
    auth: { token: jwt },
    reconnection: true,
    reconnectionDelayMax: 5_000,
  });

  return {
    socket,
    onPoolUpdate(handler) {
      const wrapped = (payload: PoolUpdateEvent) => handler(payload);
      socket.on(POOL_UPDATE_EVENT, wrapped);
      return () => {
        socket.off(POOL_UPDATE_EVENT, wrapped);
      };
    },
    close() {
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
