import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { businesses } from '../db/schema';

export function getResults(jobId: string, q: string | undefined, page: number) {
  const limit = 100;
  const offset = (page - 1) * limit;

  let query = db.select().from(businesses).where(eq(businesses.jobId, jobId));

  if (q) {
    const pattern = `%${q}%`;
    query = db.select().from(businesses).where(
      sql`${businesses.jobId} = ${jobId} AND (
        ${businesses.name} LIKE ${pattern} OR
        ${businesses.address} LIKE ${pattern} OR
        ${businesses.category} LIKE ${pattern}
      )`,
    ) as typeof query;
  }

  return query.limit(limit).offset(offset).all();
}
