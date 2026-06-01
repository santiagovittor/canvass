import { Router } from 'express';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { businesses } from '../db/schema';
import { enrichLocationJob } from '../services/locationEnricher';

const router = Router();

router.post('/enrich-locations', (_req, res) => {
  const pending = db.select().from(businesses)
    .where(and(eq(businesses.locationEnriched, 0), isNotNull(businesses.latitude), isNotNull(businesses.longitude)))
    .all();

  const count = pending.length;
  res.json({ status: 'started', pending: count });

  if (count > 0) {
    const ac = new AbortController();
    console.log(`[locationEnricher] Manual trigger: ${count} rows pending`);
    enrichLocationJob(undefined, ac.signal)
      .then(() => console.log('[locationEnricher] Manual enrichment complete.'))
      .catch(err => console.error('[locationEnricher] Manual enrichment error:', err));
  }
});

export default router;
