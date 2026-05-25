import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const appUser = pgTable('app_user', {
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
}, (t) => [
  index('app_user_phone_idx').on(t.phoneE164),
  check('app_user_role_check', sql`${t.role} IN ('client','driver')`),
  check('app_user_status_check', sql`${t.status} IN ('active','suspended','deleted')`),
]);

export const client = pgTable('client', {
  userId: uuid('user_id').primaryKey().references(() => appUser.id, { onDelete: 'cascade' }),
  homeLabel: text('home_label'),
  workLabel: text('work_label'),
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const driver = pgTable('driver', {
  userId: uuid('user_id').primaryKey().references(() => appUser.id, { onDelete: 'cascade' }),
  licenseNo: text('license_no'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  availability: text('availability').notNull().default('offline'),
  currentVehicleId: uuid('current_vehicle_id'),
  ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }),
  ratingCount: integer('rating_count').notNull().default(0),
  totalRides: integer('total_rides').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('driver_availability_check', sql`${t.availability} IN ('offline','online','on_ride')`),
]);

export const vehicle = pgTable('vehicle', {
  id: uuid('id').primaryKey(),
  driverId: uuid('driver_id').notNull().references(() => driver.userId, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  regNo: text('reg_no').notNull().unique(),
  make: text('make'),
  model: text('model'),
  color: text('color'),
  seats: integer('seats').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('vehicle_type_check', sql`${t.type} IN ('auto','bike','cab_hatch','cab_sedan')`),
]);
