import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { appUser, driver, feedback, supportMessage, vehicle } from '../../db/schema';

export type FeedbackCategory = 'bug' | 'idea' | 'compliment' | 'other';

export interface ProfileResponse {
  id: string;
  role: 'client' | 'driver';
  displayName: string | null;
  email: string | null;
  phone: string | null;
  memberSince: string;
  /** Drivers only. */
  driver?: {
    ratingAvg: number | null;
    ratingCount: number;
    totalRides: number;
    vehicle: { type: string; regNo: string; make: string | null; model: string | null; seats: number } | null;
  };
}

export interface SupportMessageDto {
  id: string;
  sender: 'user' | 'support';
  body: string;
  createdAt: string;
}

const SUPPORT_ACK =
  'Thanks for reaching out. Your message is with our support team and replies will appear in this chat.';

@Injectable()
export class AccountService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async getProfile(userId: string): Promise<ProfileResponse> {
    const [u] = await this.db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
    if (!u) throw new NotFoundException({ code: 'user_not_found', message: 'user not found' });
    const base: ProfileResponse = {
      id: u.id,
      role: u.role as 'client' | 'driver',
      displayName: u.displayName,
      email: u.email,
      phone: u.phoneE164,
      memberSince: u.createdAt.toISOString(),
    };
    if (u.role !== 'driver') return base;

    const [d] = await this.db.select().from(driver).where(eq(driver.userId, userId)).limit(1);
    const [v] = d?.currentVehicleId
      ? await this.db.select().from(vehicle).where(eq(vehicle.id, d.currentVehicleId)).limit(1)
      : [];
    return {
      ...base,
      driver: {
        ratingAvg: d?.ratingAvg != null ? Number(d.ratingAvg) : null,
        ratingCount: d?.ratingCount ?? 0,
        totalRides: d?.totalRides ?? 0,
        vehicle: v
          ? { type: v.type, regNo: v.regNo, make: v.make, model: v.model, seats: v.seats }
          : null,
      },
    };
  }

  async updateDisplayName(userId: string, displayName: string): Promise<ProfileResponse> {
    await this.db
      .update(appUser)
      .set({ displayName, updatedAt: sql`now()` })
      .where(eq(appUser.id, userId));
    return this.getProfile(userId);
  }

  async submitFeedback(
    userId: string,
    role: 'client' | 'driver',
    category: FeedbackCategory,
    message: string,
  ): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(feedback)
      .values({ userId, role, category, message })
      .returning({ id: feedback.id });
    return { id: row.id };
  }

  async listSupport(userId: string): Promise<SupportMessageDto[]> {
    // Newest 200, returned oldest-first so the chat reads top to bottom.
    const rows = await this.db
      .select()
      .from(supportMessage)
      .where(eq(supportMessage.userId, userId))
      .orderBy(desc(supportMessage.createdAt))
      .limit(200);
    return rows.reverse().map(toMessage);
  }

  /** Appends the user's message; the first one in a thread also gets an automatic acknowledgement. */
  async sendSupport(userId: string, body: string): Promise<SupportMessageDto[]> {
    return this.db.transaction(async (tx) => {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(supportMessage)
        .where(and(eq(supportMessage.userId, userId), eq(supportMessage.sender, 'user')));
      const created = await tx
        .insert(supportMessage)
        .values({ userId, sender: 'user', body })
        .returning();
      const out = created.map(toMessage);
      if (n === 0) {
        // Distinct timestamp so the ack always sorts after the message it answers.
        const ack = await tx
          .insert(supportMessage)
          .values({ userId, sender: 'support', body: SUPPORT_ACK, createdAt: sql`now() + interval '1 millisecond'` })
          .returning();
        out.push(...ack.map(toMessage));
      }
      return out;
    });
  }
}

function toMessage(r: typeof supportMessage.$inferSelect): SupportMessageDto {
  return {
    id: r.id,
    sender: r.sender as 'user' | 'support',
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  };
}
