/** SQLSTATEs that mean "this transaction lost a race; re-run it from the top". */
export const PG_DEADLOCK_DETECTED = '40P01';
export const PG_SERIALIZATION_FAILURE = '40001';

function sqlState(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string') return e.code;
  return e.cause !== undefined && e.cause !== err ? sqlState(e.cause) : null;
}

export function isRetryableTxError(err: unknown): boolean {
  const code = sqlState(err);
  return code === PG_DEADLOCK_DETECTED || code === PG_SERIALIZATION_FAILURE;
}

/**
 * Run a whole transaction, retrying it at most `maxRetries` times when Postgres
 * aborts it as a deadlock / serialization victim (contract §1.3 rule 3). When
 * the retries are exhausted the caller's typed `conflict` value is returned;
 * any other error propagates unchanged.
 */
export async function withTxRetry<T>(
  run: () => Promise<T>,
  onExhausted: () => T,
  maxRetries = 2,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isRetryableTxError(err)) throw err;
      if (attempt >= maxRetries) return onExhausted();
    }
  }
}
