import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { RealtimeBus } from './realtime.bus';
import type { JwtPayload } from '../../common/guards/auth.guard';

@WebSocketGateway({ cors: { origin: '*' }, transports: ['websocket'] })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly log = new Logger(RealtimeGateway.name);

  constructor(
    private jwt: JwtService,
    private bus: RealtimeBus,
    @Inject(REDIS) private redis: Redis,
  ) {}

  afterInit(server: Server): void {
    // Wire Redis adapter for pub/sub (no-op at single-node, zero code change for multi-node)
    const pub = this.redis.duplicate();
    const sub = this.redis.duplicate();
    server.adapter(createAdapter(pub, sub));
    this.bus.setServer(server);
    this.log.log('RealtimeGateway initialised');
  }

  handleConnection(client: Socket): void {
    const token = this._extractToken(client);
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = this.jwt.verify<JwtPayload>(token, { issuer: 'rcab' });
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      void client.join(`user:${payload.sub}`);
      if (payload.role === 'driver') {
        void client.join(`driver:${payload.sub}`);
      }
      this.log.debug(`WS connected: ${payload.sub} (${payload.role})`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.log.debug(`WS disconnected: ${client.data.userId as string | undefined ?? 'unknown'}`);
  }

  private _extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown>;
    if (typeof auth['token'] === 'string') return auth['token'];
    const header = client.handshake.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    return null;
  }
}
