import { Module, Global, OnApplicationShutdown, Inject } from '@nestjs/common';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

export const REDIS = 'REDIS';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () =>
        new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }
}
