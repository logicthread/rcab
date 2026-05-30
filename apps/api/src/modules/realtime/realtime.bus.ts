import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

@Injectable()
export class RealtimeBus {
  private readonly log = new Logger(RealtimeBus.name);
  private _server: Server | null = null;

  setServer(server: Server): void {
    this._server = server;
  }

  private get io(): Server {
    if (!this._server) throw new Error('RealtimeBus: server not initialised yet');
    return this._server;
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.io.to(`user:${userId}`).emit(event, payload);
  }

  toDriver(driverId: string, event: string, payload: unknown): void {
    this.io.to(`driver:${driverId}`).emit(event, payload);
  }

  toRide(rideId: string, event: string, payload: unknown): void {
    this.io.to(`ride:${rideId}`).emit(event, payload);
  }

  toPool(rideId: string, event: string, payload: unknown): void {
    this.io.to(`pool:${rideId}`).emit(event, payload);
  }

  async joinPool(userId: string, rideId: string): Promise<void> {
    try {
      await this.io.in(`user:${userId}`).socketsJoin(`pool:${rideId}`);
    } catch (err) {
      this.log.warn({ err, userId, rideId }, 'joinPool: socketsJoin failed');
    }
  }

  /** Place a user's sockets in `ride:<id>` so they receive `ride_state_changed`
   * for that ride. The booking client joins at request time (RCAB-E4.S6). */
  async joinRide(userId: string, rideId: string): Promise<void> {
    try {
      await this.io.in(`user:${userId}`).socketsJoin(`ride:${rideId}`);
    } catch (err) {
      this.log.warn({ err, userId, rideId }, 'joinRide: socketsJoin failed');
    }
  }

  broadcast(event: string, payload: unknown): void {
    this.io.emit(event, payload);
  }
}
