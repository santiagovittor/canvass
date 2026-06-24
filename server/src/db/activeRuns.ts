import { or, eq, ne, and, isNull, count, desc } from 'drizzle-orm';
import { db } from './index';
import { scrapeJobs, businesses } from './schema';

// Read-model rows for the active-runs strip (slice 0012). Raw Drizzle lives here
// (db-layer rule); the service in services/activeRuns.ts shapes the typed union.

export interface ActiveScrapeRow {
  jobId: string;
  status: 'running';
  businessesFound: number;
  cellCount: number;
  cellsDone: number;
}

export interface ActiveKeywordRow {
  jobId: string;
  runId: string | null;
  stage: string | null;
  query: string;
  startedAt: string;
}

// Polygon scrapes actively in flight. Only status='running' — the strip tracks
// live runs, not a graveyard of historical errors (the Scraper tab's own snapshot
// event still surfaces the latest error). Keyword runs are excluded by run_kind.
// businessesFound only persists per completed cell, so count live rows for an
// honest mid-cell number (mirrors sse.ts snapshot).
export function listActiveScrapeJobs(): ActiveScrapeRow[] {
  const jobs = db
    .select({
      jobId: scrapeJobs.id,
      businessesFound: scrapeJobs.businessesFound,
      cellCount: scrapeJobs.cellCount,
      cellsDone: scrapeJobs.cellsDone,
    })
    .from(scrapeJobs)
    .where(and(
      eq(scrapeJobs.status, 'running'),
      or(isNull(scrapeJobs.runKind), ne(scrapeJobs.runKind, 'keyword')),
    ))
    .orderBy(desc(scrapeJobs.createdAt))
    .all();

  return jobs.map(j => {
    const liveCount = db.select({ n: count() }).from(businesses)
      .where(eq(businesses.jobId, j.jobId))
      .get()?.n ?? 0;
    return { jobId: j.jobId, status: 'running', businessesFound: Math.max(j.businessesFound, liveCount), cellCount: j.cellCount, cellsDone: j.cellsDone };
  });
}

// Durable keyword runs still in flight (status='running', run_kind='keyword').
export function listActiveKeywordRuns(): ActiveKeywordRow[] {
  return db
    .select({
      jobId: scrapeJobs.id,
      runId: scrapeJobs.keywordRunId,
      stage: scrapeJobs.keywordStage,
      query: scrapeJobs.searchTerm,
      startedAt: scrapeJobs.createdAt,
    })
    .from(scrapeJobs)
    .where(and(
      eq(scrapeJobs.status, 'running'),
      eq(scrapeJobs.runKind, 'keyword'),
    ))
    .orderBy(desc(scrapeJobs.createdAt))
    .all();
}
