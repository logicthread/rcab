/**
 * Names of the Stage C (0014–0016) constraints whose violation is an expected,
 * typed business outcome rather than a bug. Repositories map a pg error's
 * `constraint` (with SQLSTATE 23505 unique_violation / 23514 check_violation)
 * to a result union using these names — never by matching message text.
 */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

export const Constraint = {
  /** 23505 — the driver already has an active trip (solo or shared). */
  AssignmentDriverBusy: 'driver_active_assignment_pkey',
  /** 23505 — the solo ride already has an assigned driver. */
  AssignmentSoloTaken: 'driver_active_assignment_solo_ride_id_key',
  /** 23505 — the shared ride already has an assigned driver. */
  AssignmentSharedTaken: 'driver_active_assignment_shared_ride_id_key',
  /** 23505 — the driver already holds a live (state='offered') offer. */
  OfferDriverHasLiveOffer: 'dispatch_offer_one_live_per_driver_uq',
  /** 23505 — this driver was already offered this trip generation. */
  OfferSoloAlreadyOffered: 'dispatch_offer_solo_driver_uq',
  OfferSharedAlreadyOffered: 'dispatch_offer_shared_driver_uq',
  /** 23505 — another offer for this trip generation is already accepted. */
  OfferSoloAlreadyAccepted: 'dispatch_offer_solo_one_accept_uq',
  OfferSharedAlreadyAccepted: 'dispatch_offer_shared_one_accept_uq',
  /** 23505 — the outbox intent already exists (idempotent writer). */
  OutboxDedupe: 'outbox_dedupe_key_uq',
  /** 23505 — passenger already a member of this pool. */
  PoolMemberDuplicate: 'pool_member_pkey',
  /** 23505 — passenger already holds a seat in another non-terminal pool. */
  PoolMemberOneActivePool: 'pool_member_one_active_pool_uq',
  /** 23505 — this idempotency key already produced a seat for the passenger. */
  PoolMemberIdempotency: 'pool_member_idempotency_uq',
  /** 23514 — the pool is not 'open' (raised by trigger pool_member_require_open). */
  PoolNotOpen: 'pool_member_pool_open',
  /** 23514 — the insert would push seat_count past max_seats (pool full). */
  PoolCapacity: 'shared_rides_seat_capacity_check',
} as const;

export type ConstraintName = (typeof Constraint)[keyof typeof Constraint];

/** Narrow an unknown thrown value to a pg error carrying a constraint name. */
export function pgConstraintViolation(
  err: unknown,
): { code: string; constraint: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && typeof e.constraint === 'string') {
    return { code: e.code, constraint: e.constraint };
  }
  // drizzle wraps driver errors in some code paths.
  return e.cause !== undefined && e.cause !== err ? pgConstraintViolation(e.cause) : null;
}
