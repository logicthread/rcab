import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { runMigrations } from '@rcab/test-fixtures';

let pg: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;

export async function setup(): Promise<void> {
  if (process.env.RCAB_SKIP_INT === '1') {
    process.env.RCAB_INT_SKIPPED = '1';
    return;
  }

  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgis/postgis:16-3.4').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  process.env.TEST_POSTGRES_URI = pg.getConnectionUri();
  process.env.TEST_REDIS_URL = redis.getConnectionUrl();

  await runMigrations(pg.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await Promise.allSettled([pg?.stop(), redis?.stop()]);
}
