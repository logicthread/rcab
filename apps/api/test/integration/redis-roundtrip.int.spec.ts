import Redis from 'ioredis';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('redis round-trip', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.TEST_REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('SET then GET returns the value', async () => {
    await redis.set('rcab:test:ping', 'pong', 'EX', 10);
    const value = await redis.get('rcab:test:ping');
    expect(value).toBe('pong');
  });

  it('DEL removes the key', async () => {
    await redis.set('rcab:test:del', 'gone');
    await redis.del('rcab:test:del');
    const value = await redis.get('rcab:test:del');
    expect(value).toBeNull();
  });
});
