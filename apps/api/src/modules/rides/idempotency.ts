import { createHash } from 'node:crypto';
import { getPolicy } from '../../config/policy/policy';
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Account-scoped idempotency contract for ride creation (F07 / F15, R05).
 *
 * A key is only meaningful inside its scope `(principal, operation, key)`:
 * the same `Idempotency-Key` sent by two accounts — or by one account for two
 * different operations — names independent requests. Each stored request also
 * carries a fingerprint of its business intent; reusing a key in its scope with
 * a different intent is rejected (422) instead of replaying or mutating.
 *
 * Retention: the durable record is the source of truth (no TTL cache in front
 * of it). Solo/scheduled keys live on the ride row for the ride's lifetime;
 * shared keys live in `idempotency_record` (no purge job in Phase-0). Because a
 * key is bound to the authenticated principal, a stale key is never a bearer
 * credential — another account can't read the result through it.
 */
export const IdempotencyOperation = {
  Solo: 'ride.create.solo',
  Scheduled: 'ride.create.scheduled',
  Shared: 'ride.create.shared',
} as const;
export type IdempotencyOperation = (typeof IdempotencyOperation)[keyof typeof IdempotencyOperation];

// Visible ASCII only, bounded: a UUID (what the web client sends) fits easily;
// whitespace/control chars and unbounded strings are rejected up front.
const KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

/** Validates the raw header; throws 400 when required and absent, or malformed. */
export function parseIdempotencyKey(raw: string | undefined, required: true): string;
export function parseIdempotencyKey(raw: string | undefined, required: false): string | undefined;
export function parseIdempotencyKey(
  raw: string | undefined,
  required: boolean,
): string | undefined {
  if (raw === undefined || raw === '') {
    if (!required) return undefined;
    throw new BadRequestException({
      code: 'idempotency_key_required',
      message: 'Idempotency-Key header is required',
    });
  }
  if (!KEY_PATTERN.test(raw)) {
    throw new BadRequestException({
      code: 'idempotency_key_invalid',
      message: 'Idempotency-Key must be 1–128 visible ASCII characters',
    });
  }
  return raw;
}

export interface FingerprintInput {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  scheduledFor?: string;
}

/**
 * SHA-256 over the canonical business intent of a create request.
 *
 * - Coordinates are normalised to 6 decimal places (~0.1 m — the same tolerance
 *   `coordsMatch` uses), so a client re-serialising the same point doesn't
 *   become a mismatch.
 * - `scheduledFor` is normalised to epoch ms, so `…Z` and `…+05:30` spellings of
 *   one instant are the same intent.
 * - The quote token is deliberately NOT part of the intent. The web client keeps
 *   one key per (ride type + route) intent; after a lost create response it
 *   re-quotes (new token) and retries under the SAME key. Binding the token
 *   would 422 that retry and push the client to rotate its key, creating a
 *   second booking. The intent is the operation (which encodes ride type),
 *   pickup/dropoff and — for scheduled — the pickup instant. There is no seat
 *   count on the create DTO yet; add it here when one exists. A replay is
 *   resolved before the quote token is validated, so a stale/new token never
 *   blocks recovering the committed ride. The access token is never part of it.
 */
export function requestFingerprint(
  operation: IdempotencyOperation,
  input: FingerprintInput,
): string {
  const scheduledMs = input.scheduledFor ? new Date(input.scheduledFor).getTime() : null;
  const canonical = {
    op: operation,
    origin: [coord(input.originLat), coord(input.originLng)],
    dest: [coord(input.destLat), coord(input.destLng)],
    scheduledFor:
      operation !== IdempotencyOperation.Scheduled
        ? null
        : scheduledMs === null || Number.isNaN(scheduledMs)
          ? (input.scheduledFor ?? null)
          : scheduledMs,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function coord(n: number): string {
  return Number(n).toFixed(6);
}

/**
 * True when a stored request may be replayed for this fingerprint. A `null`
 * stored fingerprint is a legacy row (pre-0013): it is already owner+operation
 * scoped, so it replays rather than locking the caller out of their own ride.
 */
export function fingerprintMatches(stored: string | null, incoming: string): boolean {
  return stored === null || stored === incoming;
}

export function idempotencyKeyConflict(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'idempotency_key_conflict',
    message: 'Idempotency-Key was already used for a different request — use a new key',
  });
}

/**
 * A `pending` shared-create claim older than this is presumed abandoned (the
 * process died, or `complete()` failed after the seat was allocated) and may be
 * taken over by a retry carrying the same fingerprint. Comfortably above the
 * worst-case allocation time (OSRM scoring + pool transaction), so a slow but
 * live first request is not raced.
 */
export const PENDING_RECLAIM_AFTER_MS: number = getPolicy().idempotency.pendingReclaimMs;

export function idempotencyRequestInProgress(): ConflictException {
  return new ConflictException({
    code: 'idempotency_request_in_progress',
    message: 'A request with this Idempotency-Key is still being processed — retry shortly',
  });
}
