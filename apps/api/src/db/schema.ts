import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  doublePrecision,
  jsonb,
  check,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey(),
    firebaseUid: text('firebase_uid').notNull().unique(),
    phoneE164: text('phone_e164').notNull().unique(),
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
    token: text('token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_refresh_token_user_idx').on(t.userId)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shared_rides_state_idx').on(t.poolState),
    check(
      'shared_rides_state_check',
      sql`${t.poolState} IN ('open','closed_full','closed_started','closed_timeout','aborted','completed')`,
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
    idempotencyKey: text('idempotency_key').notNull().unique(),
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
  ],
);
