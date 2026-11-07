/**
 * One idempotency key per booking intent. The key is created the first time an
 * intent (ride type + route) is submitted and then reused for every retry of
 * that same intent — so a lost response / timeout / manual retry replays the
 * original request server-side instead of double-booking. It rotates only when
 * the intent changes or after a confirmed success.
 */
export interface IntentKeyTracker {
  /** Key for this intent fingerprint; stable until the fingerprint changes or `clear()`. */
  keyFor(fingerprint: string): string;
  clear(): void;
}

export function createIntentKeyTracker(
  generate: () => string = () => crypto.randomUUID(),
): IntentKeyTracker {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(fingerprint) {
      if (!current || current.fingerprint !== fingerprint) {
        current = { fingerprint, key: generate() };
      }
      return current.key;
    },
    clear() {
      current = null;
    },
  };
}
