import { and, asc, count, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { businesses, scrapeJobs } from '../db/schema';
import { broadcast } from '../sse';
import { env } from '../env';
import { enrichSocial } from './socialEnricher';
import { enrichLocation } from './locationEnricher';

const NOMINATIM_DELAY_MS = 1100;

let running = false;
let rekick = false;
// Location failures aren't marked in the DB (so they retry after a restart);
// skip them in-process so one bad row can't loop the queue forever.
const failedLocationIds = new Set<string>();

// Global background enrichment worker, decoupled from job status: jobs reach
// "done" when scraping finishes, and this queue works through every business
// still needing social/email or location enrichment — across all jobs — at its
// own pace. Idempotent: call it whenever new work may exist (boot, cell done).
export function kickEnrichment(): void {
  if (running) { rekick = true; return; }
  running = true;
  loop()
    .catch(err => console.error('[enrichmentQueue] worker crashed:', err))
    .finally(() => {
      running = false;
      if (rekick) { rekick = false; kickEnrichment(); }
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loop(): Promise<void> {
  while (true) {
    // Social/email first — emails are the point of the pipeline
    const social = db.select({ biz: businesses, extractEmails: scrapeJobs.extractEmails })
      .from(businesses)
      .leftJoin(scrapeJobs, eq(businesses.jobId, scrapeJobs.id))
      .where(and(eq(businesses.socialEnriched, 0), isNotNull(businesses.website)))
      .orderBy(asc(businesses.scrapedAt))
      .limit(1)
      .get();
    if (social) {
      await enrichSocial(social.biz, social.extractEmails === 1);
      reportProgress(social.biz.jobId);
      await sleep(env.SOCIAL_ENRICHMENT_DELAY_MS);
      continue;
    }

    const loc = db.select().from(businesses)
      .where(and(eq(businesses.locationEnriched, 0), isNotNull(businesses.latitude), isNotNull(businesses.longitude)))
      .orderBy(asc(businesses.scrapedAt))
      .all()
      .find(b => !failedLocationIds.has(b.id));
    if (loc) {
      const ok = await enrichLocation(loc);
      if (!ok) failedLocationIds.add(loc.id);
      await sleep(NOMINATIM_DELAY_MS);
      continue;
    }

    return;
  }
}

function reportProgress(jobId: string): void {
  const withWebsite = and(eq(businesses.jobId, jobId), isNotNull(businesses.website));
  const done = db.select({ n: count() }).from(businesses)
    .where(and(withWebsite, eq(businesses.socialEnriched, 1)))
    .get()?.n ?? 0;
  const total = db.select({ n: count() }).from(businesses)
    .where(withWebsite)
    .get()?.n ?? 0;
  db.update(scrapeJobs).set({ enrichmentProgress: done }).where(eq(scrapeJobs.id, jobId)).run();
  broadcast('enrich:progress', { jobId, done, total });
}
