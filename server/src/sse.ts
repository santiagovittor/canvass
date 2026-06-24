import type { Response } from 'express';
import { db } from './db';
import { scrapeJobs, businesses } from './db/schema';
import { or, eq, ne, and, isNull, desc, count } from 'drizzle-orm';
import { getActiveRuns } from './services/activeRuns';

const clients = new Set<Response>();

function safeWrite(res: Response, payload: string): void {
  try {
    res.write(payload);
  } catch {
    clients.delete(res);
    try { res.end(); } catch {}
  }
}

export function register(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  clients.add(res);
  res.on('close', () => clients.delete(res));

  const activeJob = db
    .select({
      id: scrapeJobs.id,
      status: scrapeJobs.status,
      enrichmentProgress: scrapeJobs.enrichmentProgress,
      businessesFound: scrapeJobs.businessesFound,
      cellCount: scrapeJobs.cellCount,
      cellsDone: scrapeJobs.cellsDone,
    })
    .from(scrapeJobs)
    .where(and(
      or(
        eq(scrapeJobs.status, 'running'),
        eq(scrapeJobs.status, 'error'),
      ),
      // Exclude durable keyword runs (slice 0012) — they are now status='running'
      // but must not hijack the polygon snapshot. NULL run_kind = polygon (legacy).
      or(isNull(scrapeJobs.runKind), ne(scrapeJobs.runKind, 'keyword')),
    ))
    .orderBy(desc(scrapeJobs.createdAt))
    .limit(1)
    .get();

  if (activeJob) {
    // businessesFound only persists per completed cell — mid-cell rows are
    // already in the DB, so count them live for an honest snapshot
    const liveCount = db.select({ n: count() }).from(businesses)
      .where(eq(businesses.jobId, activeJob.id))
      .get()?.n ?? 0;
    safeWrite(res, `event: snapshot\ndata: ${JSON.stringify({
      id: activeJob.id,
      status: activeJob.status,
      progress: activeJob.enrichmentProgress,
      businessesFound: Math.max(activeJob.businessesFound, liveCount),
      cellCount: activeJob.cellCount,
      cellsDone: activeJob.cellsDone,
    })}\n\n`);
  } else {
    safeWrite(res, `event: snapshot\ndata: ${JSON.stringify({ type: 'idle' })}\n\n`);
  }

  // Server-authoritative active-runs snapshot (slice 0012): every active run
  // (scrape, keyword, batch, premium) so a freshly-connected/returned client
  // rehydrates the strip without polling. Mirrors GET /api/runs/active.
  const activeRuns = getActiveRuns();
  console.log(`[sse] register() emitting runs:snapshot — ${activeRuns.length} active run(s)`);
  safeWrite(res, `event: runs:snapshot\ndata: ${JSON.stringify(activeRuns)}\n\n`);
}

export function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    safeWrite(res, payload);
  }
}

setInterval(() => {
  for (const res of clients) {
    safeWrite(res, ': heartbeat\n\n');
  }
}, 25_000).unref();
