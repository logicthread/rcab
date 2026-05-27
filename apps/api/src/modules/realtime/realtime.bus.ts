import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

@Injectable()
export class RealtimeBus {
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

  broadcast(event: string, payload: unknown): void {
    this.io.emit(event, payload);
  }
}
