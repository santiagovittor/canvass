import { Router } from 'express';
import { getSchedulerHealth } from '../services/scheduledSendWorker';
import { getScheduledCounts, getNextScheduledRows } from '../db';

const router = Router();

router.get('/status', (_req, res) => {
  const health = getSchedulerHealth();
  const counts = getScheduledCounts();
  const next = getNextScheduledRows(20);
  res.json({
    health,
    counts: {
      scheduled: counts.scheduled,
      sending: counts.sending,
      sent_today: counts.sent_today,
      deferred: counts.deferred,
      held_now: health.lastTickCounts.held,  // in-memory, not DB
      superseded_today: counts.superseded_today,
      failed_today: counts.failed_today,
    },
    next,
  });
});

export default router;
