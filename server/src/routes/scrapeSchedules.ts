import { Router } from 'express';
import {
  createSchedule, listSchedules, getSchedule, updateSchedule,
  deleteSchedule, getRecentRuns,
} from '../db/scrapeSchedules';
import { getScrapeSchedulerHealth, setScrapeSchedulerPaused } from '../services/scrapeSchedulerWorker';

const router = Router();

// GET /status — health + recent runs
router.get('/status', (_req, res) => {
  const health = getScrapeSchedulerHealth();
  const recentRuns = getRecentRuns({ limit: 20 });
  res.json({ health, recentRuns });
});

// POST /pause
router.post('/pause', (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  setScrapeSchedulerPaused(true, reason);
  const health = getScrapeSchedulerHealth();
  res.json({ paused: true, pausedAt: health.pausedAt });
});

// POST /resume
router.post('/resume', (_req, res) => {
  setScrapeSchedulerPaused(false);
  res.json({ paused: false });
});

// GET / — list schedules with last 5 runs each
router.get('/', (_req, res) => {
  const schedules = listSchedules();
  const schedulesWithRuns = schedules.map(s => ({
    ...s,
    recentRuns: getRecentRuns({ scheduleId: s.id, limit: 5 }),
  }));
  res.json(schedulesWithRuns);
});

// POST / — create
router.post('/', (req, res) => {
  const { name, polygon_json, business_type, interval_minutes, enabled = 1 } = req.body ?? {};
  if (!name || !polygon_json || !business_type || !interval_minutes) {
    return void res.status(400).json({ error: 'name, polygon_json, business_type, interval_minutes required' });
  }
  const row = createSchedule({ name, polygon_json, business_type, interval_minutes, enabled });
  res.status(201).json(row);
});

// PATCH /:id — update subset
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const row = updateSchedule(id, req.body ?? {});
  if (!row) return void res.status(404).json({ error: 'not_found' });
  res.json(row);
});

// DELETE /:id
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const ok = deleteSchedule(id);
  if (!ok) return void res.status(404).json({ error: 'not_found' });
  res.json({ deleted: true, id });
});

// POST /:id/run-now — set next_run_at = now so worker picks up on next tick
router.post('/:id/run-now', (req, res) => {
  const { id } = req.params;
  const row = updateSchedule(id, { next_run_at: new Date().toISOString(), enabled: 1 });
  if (!row) return void res.status(404).json({ error: 'not_found' });
  res.json(row);
});

export default router;
