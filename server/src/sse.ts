import type { Response } from 'express';
import { db } from './db';
import { scrapeJobs } from './db/schema';
import { or, eq } from 'drizzle-orm';

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
    })
    .from(scrapeJobs)
    .where(or(eq(scrapeJobs.status, 'running'), eq(scrapeJobs.status, 'enriching')))
    .limit(1)
    .get();

  if (activeJob) {
    safeWrite(res, `event: snapshot\ndata: ${JSON.stringify({
      id: activeJob.id,
      status: activeJob.status,
      progress: activeJob.enrichmentProgress,
      businessesFound: activeJob.businessesFound,
      cellCount: activeJob.cellCount,
    })}\n\n`);
  } else {
    safeWrite(res, `event: snapshot\ndata: ${JSON.stringify({ type: 'idle' })}\n\n`);
  }
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
