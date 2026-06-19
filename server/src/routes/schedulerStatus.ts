import { Router } from 'express';
import { getSchedulerHealth, setPaused } from '../services/scheduledSendWorker';
import {
  getScheduledCounts, getNextScheduledRows,
  getScheduledSendById, cancelScheduledSend,
  cancelScheduledSendsByBusiness, cancelAllPendingScheduledSends,
} from '../db';

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
      canceled_today: counts.canceled_today,
      failed_today: counts.failed_today,
    },
    next,
  });
});

router.post('/pause', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  setPaused(true, reason);
  const health = getSchedulerHealth();
  res.json({ paused: true, pausedAt: health.pausedAt });
});

router.post('/resume', (_req, res) => {
  setPaused(false);
  res.json({ paused: false });
});

router.post('/cancel/:id', (req, res) => {
  const { id } = req.params;
  const row = getScheduledSendById(id);
  if (!row) return void res.status(404).json({ error: 'not_found' });
  if (row.status === 'claimed') {
    return void res.status(409).json({
      error: 'in_flight',
      hint: 'Row is mid-send; wait for stale-reaper (10 min) or retry.',
    });
  }
  const ok = cancelScheduledSend(id);
  if (!ok) {
    const current = getScheduledSendById(id);
    return void res.status(409).json({
      error: current?.status === 'claimed' ? 'in_flight' : 'already_terminal',
      status: current?.status ?? row.status,
    });
  }
  res.json({ canceled: true, id });
});

router.post('/cancel-business/:businessId', (req, res) => {
  const { businessId } = req.params;
  const canceledCount = cancelScheduledSendsByBusiness(businessId);
  res.json({ canceledCount });
});

router.post('/cancel-all-pending', (_req, res) => {
  const canceledCount = cancelAllPendingScheduledSends();
  res.json({ canceledCount });
});

export default router;
