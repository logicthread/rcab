import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { runMigrations } from '@rcab/test-fixtures';

let pg: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;

export async function setup(): Promise<void> {
  // Disable BullMQ Worker autorun across all integration specs. Without this,
  // every spec that boots AppModule starts a blocking BRPOPLPUSH that rejects
  // on shutdown with `Connection is closed.`, breaking suite-level results.
  // Specs that need a real worker should run it explicitly.
  process.env.RCAB_DISABLE_BULL_AUTORUN = '1';

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

  // App-bootstrap specs (`Test.createTestingModule({ imports: [AppModule] })`)
  // read REDIS_URL / DATABASE_URL from config, which default to the docker
  // service hostnames (`redis:6379` / `postgres:5432`). Those only resolve
  // inside the compose network — on a bare host (or a Jenkins agent not joined
  // to that network) they throw `ENOTFOUND redis`. Point them at the ephemeral
  // Testcontainers instances so the suite runs anywhere.
  process.env.REDIS_URL = redis.getConnectionUrl();
  process.env.DATABASE_URL = pg.getConnectionUri();

  await runMigrations(pg.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await Promise.allSettled([pg?.stop(), redis?.stop()]);
}
