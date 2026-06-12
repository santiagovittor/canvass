import { Router } from 'express';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { businesses } from '../db/schema';
import { kickEnrichment } from '../services/enrichmentQueue';

const router = Router();

router.post('/enrich-locations', (_req, res) => {
  const pending = db.select().from(businesses)
    .where(and(eq(businesses.locationEnriched, 0), isNotNull(businesses.latitude), isNotNull(businesses.longitude)))
    .all();

  res.json({ status: 'started', pending: pending.length });
  kickEnrichment();
});

export default router;
