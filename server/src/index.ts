import express from 'express';
import cors from 'cors';
import path from 'path';
import { env } from './env';
import { runMigrations } from './db/migrate';
import { sqlite } from './db';
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
import trackRouter from './routes/track';
import { startReplyChecker } from './services/replyChecker';
import { resumeOrphanedJobs } from './services/jobRunner';
import { kickEnrichment } from './services/enrichmentQueue';
import { kickPremiumAnalysis } from './services/premiumAnalysisQueue';
import { resetOrphanedRunning } from './db/premium';

runMigrations();
resumeOrphanedJobs();
// Pick up any social/location enrichment left unfinished by a restart
kickEnrichment();
// Premium analyses orphaned mid-run by a restart go back to pending and resume
resetOrphanedRunning();
kickPremiumAnalysis();

const app = express();

app.use(cors());
app.use(express.json());
// Tracking pixel must stay above authMiddleware — fetched by recipients' mail clients
app.use('/t', trackRouter);
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

startReplyChecker();

function shutdown() {
  sqlite.pragma('wal_checkpoint(FULL)');
  sqlite.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
