import { Module, Global } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://rcab:rcab@postgres:5432/rcab';

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/** The handle a `db.transaction(async (tx) => …)` callback receives. */
export type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Anything a repository method can run SQL on: the pool-backed db or an open
 * transaction. Stage C repository methods that take part in a cross-slice
 * transaction accept this as their first argument (see stage-c contract).
 */
export type DbExecutor = DrizzleDb | DrizzleTx;

export const PG_POOL = 'PG_POOL';
export const DRIZZLE_DB = 'DRIZZLE_DB';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: DATABASE_URL }),
    },
    {
      provide: DRIZZLE_DB,
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
      inject: [PG_POOL],
    },
  ],
  exports: [PG_POOL, DRIZZLE_DB],
})
export class DrizzleModule {}
