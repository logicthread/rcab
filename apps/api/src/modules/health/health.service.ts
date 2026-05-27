import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { PG_POOL } from '../../infra/db/drizzle.module';
import { REDIS } from '../../infra/redis/redis.module';

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private pool: Pool,
    @Inject(REDIS) private redis: Redis,
  ) {}

  liveness(): { ok: true } {
    return { ok: true };
  }

  async readiness(): Promise<{ ok: boolean; postgres: boolean; redis: boolean; osrm: boolean }> {
    const [postgres, redis, osrm] = await Promise.all([
      this.probePostgres(),
      this.probeRedis(),
      this.probeOsrm(),
    ]);
    return { ok: postgres && redis && osrm, postgres, redis, osrm };
  }

  private async probePostgres(): Promise<boolean> {
    try { await this.pool.query('SELECT 1'); return true; } catch { return false; }
  }

  private async probeRedis(): Promise<boolean> {
    try { return (await this.redis.ping()) === 'PONG'; } catch { return false; }
  }

  private async probeOsrm(): Promise<boolean> {
    const osrmUrl = process.env.OSRM_URL ?? 'http://osrm:5000';
    try {
      const res = await fetch(`${osrmUrl}/nearest/v1/driving/91.7,26.1`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch { return false; }
  }
}
