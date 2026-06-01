import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { ratings } from '../../db/schema';

export interface RatingRow {
  id: string;
  rideId: string;
  raterId: string;
  subjectId: string;
  stars: number;
  text: string | null;
  createdAt: Date;
}

function toRow(r: typeof ratings.$inferSelect): RatingRow {
  return {
    id: r.id,
    rideId: r.rideId,
    raterId: r.raterId,
    subjectId: r.subjectId,
    stars: Number(r.stars),
    text: r.text,
    createdAt: r.createdAt,
  };
}

@Injectable()
export class RatingRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Insert one rating. The `(ride_id, rater_id, subject_id)` UNIQUE makes a
   * repeat submission for the same direction a no-op: `onConflictDoNothing`
   * returns zero rows, which the service maps to `already_rated`. RCAB-E4.S9.
   */
  async insert(params: {
    rideId: string;
    raterId: string;
    subjectId: string;
    stars: number;
    text: string | null;
  }): Promise<RatingRow | null> {
    const inserted = await this.db
      .insert(ratings)
      .values({
        rideId: params.rideId,
        raterId: params.raterId,
        subjectId: params.subjectId,
        stars: params.stars,
        text: params.text,
      })
      .onConflictDoNothing({
        target: [ratings.rideId, ratings.raterId, ratings.subjectId],
      })
      .returning();
    return inserted[0] ? toRow(inserted[0]) : null;
  }
}
