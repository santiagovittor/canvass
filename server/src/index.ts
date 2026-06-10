import express from 'express';
import cors from 'cors';
import path from 'path';
import { env } from './env';
import { runMigrations } from './db/migrate';
import { sqlite, markOrphanedJobsFailed } from './db';
import { authMiddleware } from './middleware/auth';
import scrapeRouter from './routes/scrape';
import jobsRouter from './routes/jobs';
import resultsRouter from './routes/results';
import exportRouter from './routes/export';
import eventsRouter from './routes/events';
import businessesRouter from './routes/businesses';
import outreachRouter from './routes/outreach';
import outreachQueueRouter from './routes/outreachQueue';
import adminRouter from './routes/admin';
import analyticsRouter from './routes/analytics';
import { enrichLocationJob } from './services/locationEnricher';
import { db } from './db';
import { businesses } from './db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';

runMigrations();
markOrphanedJobsFailed();

// Backfill location enrichment for rows scraped before this feature landed
(async () => {
  const pending = db.select().from(businesses)
    .where(and(eq(businesses.locationEnriched, 0), isNotNull(businesses.latitude), isNotNull(businesses.longitude)))
    .all();
  if (pending.length > 0) {
    console.log(`[locationEnricher] Starting backfill for ${pending.length} rows...`);
    const ac = new AbortController();
    await enrichLocationJob(undefined, ac.signal);
    console.log('[locationEnricher] Backfill complete.');
  }
})();

const app = express();

app.use(cors());
app.use(express.json());
app.use(authMiddleware);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({
  senderName: env.GMAIL_SENDER_NAME ?? '',
  senderEmail: env.GMAIL_FROM ?? '',
}));
app.use('/api/scrape', scrapeRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/results', resultsRouter);
app.use('/api/export', exportRouter);
app.use('/api/businesses', businessesRouter);
app.use('/api/businesses', outreachRouter);
app.use('/api/outreach', outreachQueueRouter);
app.use('/api/admin', adminRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/events', eventsRouter);

if (env.NODE_ENV === 'production') {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.listen(env.PORT, () => {
  console.log(`Server running on :${env.PORT} [${env.NODE_ENV}]`);
});

function shutdown() {
  sqlite.pragma('wal_checkpoint(FULL)');
  sqlite.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
