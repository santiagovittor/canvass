import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { scrapeJobs } from '../db/schema';

export function getJobs() {
  return db.select().from(scrapeJobs).orderBy(desc(scrapeJobs.createdAt)).limit(50).all();
}

export function getJobById(id: string) {
  return db.select().from(scrapeJobs).where(eq(scrapeJobs.id, id)).get();
}
