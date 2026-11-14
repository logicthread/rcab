import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  smallint,
  numeric,
  boolean,
  doublePrecision,
  jsonb,
  check,
  index,
  primaryKey,
  unique,
  uniqueIndex,
  bigint,
  bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey(),
    // Nullable since 0018 (RCAB-E8.S15): Google-registered accounts have
    // neither; app_user_identity_check keeps phone or google_sub present.
    firebaseUid: text('firebase_uid').unique(),
    phoneE164: text('phone_e164').unique(),
    googleSub: text('google_sub').unique(),
    email: text('email'),
    displayName: text('display_name'),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('app_user_phone_idx').on(t.phoneE164),
    check('app_user_role_check', sql`${t.role} IN ('client','driver')`),
    check('app_user_status_check', sql`${t.status} IN ('active','suspended','deleted')`),
    check('app_user_identity_check', sql`${t.phoneE164} IS NOT NULL OR ${t.googleSub} IS NOT NULL`),
  ],
);

export const client = pgTable('client', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => appUser.id, { onDelete: 'cascade' }),
  homeLabel: text('home_label'),
  workLabel: text('work_label'),
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driver = pgTable(
  'driver',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    licenseNo: text('license_no'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    availability: text('availability').notNull().default('offline'),
    currentVehicleId: uuid('current_vehicle_id'),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count').notNull().default(0),
    totalRides: integer('total_rides').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('driver_availability_check', sql`${t.availability} IN ('offline','online','on_ride')`),
  ],
);

export const authRefreshToken = pgTable(
  'auth_refresh_token',
  {
    // SHA-256 hex digest of the opaque refresh token — the raw token is never stored (0012).
    tokenHash: text('token_hash').primaryKey(),
    // Session family: every rotation of one login shares it; replay revokes the family.
    familyId: uuid('family_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    authMethod: text('auth_method').notNull().default('phone'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('auth_refresh_token_user_idx').on(t.userId),
    index('auth_refresh_token_family_idx').on(t.familyId),
    check('auth_refresh_token_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('auth_refresh_token_auth_method_check', sql`${t.authMethod} IN ('phone','google')`),
  ],
);

export interface SharedRideMember {
  passenger_id: string;
  origin_lat: number;
  origin_lng: number;
  dest_lat: number;
  dest_lng: number;
  joined_at: string;
}

export const sharedRide = pgTable(
  'shared_rides',
  {
    rideId: uuid('ride_id').primaryKey(),
    seatCount: integer('seat_count').notNull().default(0),
    maxSeats: integer('max_seats').notNull().default(3),
    poolState: text('pool_state').notNull().default('open'),
    poolOpenedAt: timestamp('pool_opened_at', { withTimezone: true }).notNull().defaultNow(),
    poolClosedAt: timestamp('pool_closed_at', { withTimezone: true }),
    detourBudgetM: integer('detour_budget_m').notNull().default(800),
    originLat: doublePrecision('origin_lat').notNull(),
    originLng: doublePrecision('origin_lng').notNull(),
    destLat: doublePrecision('dest_lat').notNull(),
    destLng: doublePrecision('dest_lng').notNull(),
    members: jsonb('members').notNull().$type<SharedRideMember[]>().default([]),
    claimedByDriverId: uuid('claimed_by_driver_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // F05/F06 (0014): every offer + dispatch job targets one generation; work
    // for an older generation is stale. 0 = not yet dispatched (open pool).
    dispatchGeneration: integer('dispatch_generation').notNull().default(0),
    // F09 (0016): bumped by trigger on every UPDATE; Redis pool projections
    // carry it and never overwrite a newer version.
    stateVersion: bigint('state_version', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shared_rides_state_idx').on(t.poolState),
    check(
      'shared_rides_state_check',
      sql`${t.poolState} IN ('open','closed_full','closed_started','closed_timeout','aborted','completed')`,
    ),
    check('shared_rides_dispatch_generation_check', sql`${t.dispatchGeneration} >= 0`),
    check('shared_rides_max_seats_check', sql`${t.maxSeats} >= 1`),
    // seat_count is DERIVED from pool_member by trigger (0016) — never write it.
    check(
      'shared_rides_seat_capacity_check',
      sql`${t.seatCount} >= 0 AND ${t.seatCount} <= ${t.maxSeats}`,
    ),
  ],
);

export const rideStop = pgTable(
  'ride_stops',
  {
    rideId: uuid('ride_id')
      .notNull()
      .references(() => sharedRide.rideId, { onDelete: 'cascade' }),
    sequenceIndex: integer('sequence_index').notNull(),
    passengerId: uuid('passenger_id').notNull(),
    type: text('type').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.rideId, t.sequenceIndex] }),
    check('ride_stops_type_check', sql`${t.type} IN ('pickup','dropoff')`),
    index('ride_stops_pending_idx').on(t.rideId, t.sequenceIndex),
  ],
);

export const vehicle = pgTable(
  'vehicle',
  {
    id: uuid('id').primaryKey(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => driver.userId, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    regNo: text('reg_no').notNull().unique(),
    make: text('make'),
    model: text('model'),
    color: text('color'),
    seats: integer('seats').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('vehicle_type_check', sql`${t.type} IN ('auto','bike','cab_hatch','cab_sedan')`)],
);

// Solo (normal) rides — RCAB-E4.S2. Created 'requested'; RCAB-E4.S6 owns the
// full state machine. Distinct from shared_rides (pooled).
export const rides = pgTable(
  'rides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    passengerId: uuid('passenger_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    originLat: doublePrecision('origin_lat').notNull(),
    originLng: doublePrecision('origin_lng').notNull(),
    destLat: doublePrecision('dest_lat').notNull(),
    destLng: doublePrecision('dest_lng').notNull(),
    fareCents: integer('fare_cents').notNull(),
    status: text('status').notNull().default('requested'),
    // RCAB-E6.S2: 'scheduled' rides carry a future scheduled_for and are woken
    // ~10 min before pickup (BullMQ). 'normal'/'shared' dispatch immediately.
    type: text('type').notNull().default('normal'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    // F07 / R05 (0013): the key is scoped to (passenger, operation) — no longer
    // globally unique — and bound to a fingerprint of the request's intent.
    // NULL fingerprint = legacy pre-0013 row (replayable by its owner only).
    idempotencyKey: text('idempotency_key').notNull(),
    idempotencyOperation: text('idempotency_operation').notNull().default('ride.create.solo'),
    requestFingerprint: text('request_fingerprint'),
    driverId: uuid('driver_id'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    enRouteAt: timestamp('en_route_at', { withTimezone: true }),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // Cancellation / no-show bookkeeping — RCAB-E4.S8. No fee column ships in
    // Phase-0 (cancellation is free; fee mechanism deferred to a later phase).
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by'),
    cancelReason: text('cancel_reason'),
    // F05/F06 (0014): 0 = not yet dispatched (un-woken scheduled ride).
    dispatchGeneration: integer('dispatch_generation').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rides_passenger_idx').on(t.passengerId),
    index('rides_driver_idx').on(t.driverId),
    check(
      'rides_status_check',
      sql`${t.status} IN ('requested','dispatching','accepted','en_route','arrived','in_progress','completed','cancelled','no_driver','no_show')`,
    ),
    check(
      'rides_cancelled_by_check',
      sql`${t.cancelledBy} IS NULL OR ${t.cancelledBy} IN ('client','driver')`,
    ),
    check('rides_type_check', sql`${t.type} IN ('normal','shared','scheduled')`),
    unique('rides_idempotency_scope_uq').on(
      t.passengerId,
      t.idempotencyOperation,
      t.idempotencyKey,
    ),
    check(
      'rides_idempotency_operation_check',
      sql`${t.idempotencyOperation} IN ('ride.create.solo','ride.create.scheduled')`,
    ),
    check('rides_dispatch_generation_check', sql`${t.dispatchGeneration} >= 0`),
  ],
);

// Durable idempotency records for create operations that have no single row
// of their own to carry the key — shared create (a seat in a pool) today.
// Scoped by (principal, operation, key) and bound to a request fingerprint.
// `pending` is claimed before the side effect; `completed` holds the replayable
// response. F07 / F15 / R05 (0013).
export const idempotencyRecord = pgTable(
  'idempotency_record',
  {
    principalId: uuid('principal_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    state: text('state').notNull().default('pending'),
    resourceId: uuid('resource_id'),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.operation, t.idempotencyKey] }),
    check('idempotency_record_state_check', sql`${t.state} IN ('pending','completed')`),
  ],
);

// Two-sided ratings — RCAB-E4.S9. One row per (ride, rater, subject); capture
// only (aggregation + denorm to user.rating_avg/_count is Epic E7). Plain uuid
// refs (no cross-table FK — mirrors rides.driver_id).
export const ratings = pgTable(
  'ratings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rideId: uuid('ride_id').notNull(),
    raterId: uuid('rater_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    stars: smallint('stars').notNull(),
    text: text('text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('ratings_unique_direction').on(t.rideId, t.raterId, t.subjectId),
    check('ratings_stars_check', sql`${t.stars} BETWEEN 1 AND 5`),
    check('ratings_no_self_check', sql`${t.raterId} <> ${t.subjectId}`),
    index('ratings_subject_idx').on(t.subjectId, t.createdAt),
  ],
);

// ── Stage C: offers, assignment guard, outbox, pool membership (0014–0016) ──

// Rows a migration could not apply mechanically (driver with two active trips,
// orphan pool member, seat_count mismatch, …). Operator-resolved; never a
// silent repair. 0014 / 0016.
export const migrationConflict = pgTable(
  'migration_conflict',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    migration: text('migration').notNull(),
    kind: text('kind').notNull(),
    subject: jsonb('subject').notNull(),
    detail: jsonb('detail').notNull().default({}),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),
  },
  (t) => [
    unique('migration_conflict_once_uq').on(t.migration, t.kind, t.subject),
    index('migration_conflict_open_idx')
      .on(t.migration, t.kind)
      .where(sql`${t.resolvedAt} IS NULL`),
  ],
);

export type DispatchOfferState = 'offered' | 'accepted' | 'declined' | 'expired' | 'revoked';

// Authoritative dispatch offer (F05 / R06, 0014). The accept path derives the
// trip from this row and validates driver, state, generation and expires_at
// (DB clock) inside the assignment transaction. Redis offer keys are at most a
// projection.
export const dispatchOffer = pgTable(
  'dispatch_offer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripKind: text('trip_kind').notNull().$type<'solo' | 'shared'>(),
    rideId: uuid('ride_id').references(() => rides.id, { onDelete: 'cascade' }),
    sharedRideId: uuid('shared_ride_id').references(() => sharedRide.rideId, {
      onDelete: 'cascade',
    }),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => driver.userId, { onDelete: 'cascade' }),
    dispatchGeneration: integer('dispatch_generation').notNull(),
    waveNumber: smallint('wave_number').notNull().default(1),
    state: text('state').notNull().default('offered').$type<DispatchOfferState>(),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // When the offer left 'offered' (accepted / declined / expired / revoked).
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    check('dispatch_offer_trip_kind_check', sql`${t.tripKind} IN ('solo', 'shared')`),
    check('dispatch_offer_one_trip_check', sql`num_nonnulls(${t.rideId}, ${t.sharedRideId}) = 1`),
    check(
      'dispatch_offer_trip_matches_kind_check',
      sql`(${t.tripKind} = 'solo') = (${t.rideId} IS NOT NULL)`,
    ),
    check(
      'dispatch_offer_state_check',
      sql`${t.state} IN ('offered', 'accepted', 'declined', 'expired', 'revoked')`,
    ),
    check('dispatch_offer_generation_check', sql`${t.dispatchGeneration} >= 1`),
    check('dispatch_offer_wave_check', sql`${t.waveNumber} >= 1`),
    check('dispatch_offer_expiry_check', sql`${t.expiresAt} > ${t.offeredAt}`),
    check(
      'dispatch_offer_resolved_check',
      sql`(${t.state} = 'offered') = (${t.resolvedAt} IS NULL)`,
    ),
    unique('dispatch_offer_solo_driver_uq').on(t.rideId, t.dispatchGeneration, t.driverId),
    unique('dispatch_offer_shared_driver_uq').on(t.sharedRideId, t.dispatchGeneration, t.driverId),
    uniqueIndex('dispatch_offer_one_live_per_driver_uq')
      .on(t.driverId)
      .where(sql`${t.state} = 'offered'`),
    uniqueIndex('dispatch_offer_solo_one_accept_uq')
      .on(t.rideId, t.dispatchGeneration)
      .where(sql`${t.state} = 'accepted' AND ${t.rideId} IS NOT NULL`),
    uniqueIndex('dispatch_offer_shared_one_accept_uq')
      .on(t.sharedRideId, t.dispatchGeneration)
      .where(sql`${t.state} = 'accepted' AND ${t.sharedRideId} IS NOT NULL`),
    index('dispatch_offer_live_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'offered'`),
  ],
);

// The ONE driver-exclusivity guard across solo + shared trips (F06 / R06,
// 0014). PK driver_id = at most one active trip per driver; UNIQUE trip ids =
// at most one driver per trip. Inserted in the claim transaction, deleted in
// the transaction that moves the trip to a terminal state.
export const driverActiveAssignment = pgTable(
  'driver_active_assignment',
  {
    driverId: uuid('driver_id')
      .primaryKey()
      .references(() => driver.userId, { onDelete: 'cascade' }),
    soloRideId: uuid('solo_ride_id')
      .unique()
      .references(() => rides.id, { onDelete: 'cascade' }),
    sharedRideId: uuid('shared_ride_id')
      .unique()
      .references(() => sharedRide.rideId, { onDelete: 'cascade' }),
    offerId: uuid('offer_id')
      .unique()
      .references(() => dispatchOffer.id, { onDelete: 'set null' }),
    dispatchGeneration: integer('dispatch_generation').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'driver_active_assignment_one_trip_check',
      sql`num_nonnulls(${t.soloRideId}, ${t.sharedRideId}) = 1`,
    ),
    check('driver_active_assignment_generation_check', sql`${t.dispatchGeneration} >= 1`),
  ],
);

// Transactional outbox (F08 / R07, 0015). Written in the same transaction as
// the business mutation; an in-process relay leases due rows, publishes a
// deterministic BullMQ job and acks with the lease token. `processed_at` means
// published, not business-complete.
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    topic: text('topic').notNull(),
    aggregateType: text('aggregate_type').notNull().$type<'ride' | 'shared_ride'>(),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateGeneration: integer('aggregate_generation').notNull().default(0),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    payloadVersion: smallint('payload_version').notNull().default(1),
    dedupeKey: text('dedupe_key').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    lastError: text('last_error'),
    leaseToken: uuid('lease_token'),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('outbox_dedupe_key_uq').on(t.dedupeKey),
    check('outbox_topic_format_check', sql`${t.topic} ~ '^[a-z]+(\\.[a-z_]+)+$'`),
    check('outbox_aggregate_type_check', sql`${t.aggregateType} IN ('ride', 'shared_ride')`),
    check('outbox_generation_check', sql`${t.aggregateGeneration} >= 0`),
    check('outbox_attempts_check', sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`),
    check('outbox_payload_object_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
    check(
      'outbox_terminal_check',
      sql`NOT (${t.processedAt} IS NOT NULL AND ${t.failedAt} IS NOT NULL)`,
    ),
    check('outbox_lease_pair_check', sql`(${t.leaseToken} IS NULL) = (${t.leasedUntil} IS NULL)`),
    index('outbox_due_idx')
      .on(t.availableAt)
      .where(sql`${t.processedAt} IS NULL AND ${t.failedAt} IS NULL`),
    index('outbox_aggregate_idx').on(t.aggregateType, t.aggregateId, t.topic),
  ],
);

// Authoritative pool membership (F09 / R08, 0016). One seat per member in
// Phase-0. Triggers: insert only into an 'open' pool (constraint name
// pool_member_pool_open), seat_count += seats on insert / -= on delete (the
// shared_rides capacity CHECK rejects oversubscription), active=false when the
// pool reaches 'aborted' / 'completed'. Lock order: shared_rides → pool_member.
export const poolMember = pgTable(
  'pool_member',
  {
    poolId: uuid('pool_id')
      .notNull()
      .references(() => sharedRide.rideId, { onDelete: 'cascade' }),
    passengerId: uuid('passenger_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    seats: smallint('seats').notNull().default(1),
    originLat: doublePrecision('origin_lat').notNull(),
    originLng: doublePrecision('origin_lng').notNull(),
    destLat: doublePrecision('dest_lat').notNull(),
    destLng: doublePrecision('dest_lng').notNull(),
    // LEGACY (pre-0017): optional per-seat price shown at join. No longer
    // written; backfilled into agreed_fare_cents.
    quotedFareCents: integer('quoted_fare_cents'),
    // Phase-0 stand-in policy SHARED_FARE_POLICY = 'fixed_at_join' (F15/R10):
    // the per-seat fare in integer paise this passenger agreed to, quoted inside
    // the join transaction and never readjusted. NOT NULL for new rows (trigger
    // pool_member_agreed_fare_guard, 0017); NULL only on legacy rows.
    agreedFareCents: integer('agreed_fare_cents'),
    // Durable link from a shared-create idempotency claim to its seat.
    idempotencyKey: text('idempotency_key'),
    active: boolean('active').notNull().default(true),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.poolId, t.passengerId] }),
    check('pool_member_one_seat_check', sql`${t.seats} = 1`),
    check(
      'pool_member_fare_check',
      sql`${t.quotedFareCents} IS NULL OR ${t.quotedFareCents} >= 0`,
    ),
    check(
      'pool_member_agreed_fare_check',
      sql`${t.agreedFareCents} IS NULL OR ${t.agreedFareCents} >= 0`,
    ),
    check('pool_member_left_check', sql`${t.active} = (${t.leftAt} IS NULL)`),
    unique('pool_member_idempotency_uq').on(t.passengerId, t.idempotencyKey),
    uniqueIndex('pool_member_one_active_pool_uq')
      .on(t.passengerId)
      .where(sql`${t.active}`),
    index('pool_member_passenger_idx').on(t.passengerId, t.joinedAt.desc()),
  ],
);
