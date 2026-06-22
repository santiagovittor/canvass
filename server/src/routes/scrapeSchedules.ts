import { Router } from 'express';
import { z } from 'zod';
import {
  createSchedule, listSchedules, getSchedule, updateSchedule,
  deleteSchedule, getRecentRuns,
} from '../db/scrapeSchedules';
import { getScrapeSchedulerHealth, setScrapeSchedulerPaused } from '../services/scrapeSchedulerWorker';
import { getAutoAnalyzeHealth, setAutoAnalyzePaused } from '../services/premiumAnalysisQueue';

const createScheduleSchema = z.object({
  name: z.string().min(1),
  polygon_json: z.string().optional().default('{}'),
  business_type: z.string().optional().default(''),
  interval_minutes: z.number().int().min(0),
  enabled: z.number().int().min(0).max(1).optional().default(1),
  kind: z.enum(['polygon', 'keyword']).optional().default('polygon'),
  language: z.string().optional().nullable(),
  grid_cell_km: z.number().positive().optional().nullable(),
  keyword_query: z.string().optional().nullable(),
  geo_lat: z.string().optional().nullable(),
  geo_lng: z.string().optional().nullable(),
  geo_radius: z.number().int().positive().optional().nullable(),
  depth: z.number().int().min(1).max(20).optional().nullable(),
}).superRefine((v, ctx) => {
  if (v.kind === 'polygon' && (!v.polygon_json || v.polygon_json === '{}')) {
    ctx.addIssue({ code: 'custom', message: 'polygon_json required for polygon kind', path: ['polygon_json'] });
  }
  if (v.kind === 'polygon' && !v.business_type?.trim()) {
    ctx.addIssue({ code: 'custom', message: 'business_type required for polygon kind', path: ['business_type'] });
  }
  if (v.kind === 'keyword' && !v.keyword_query?.trim()) {
    ctx.addIssue({ code: 'custom', message: 'keyword_query required for keyword kind', path: ['keyword_query'] });
  }
  const geoCount = [v.geo_lat, v.geo_lng, v.geo_radius].filter(x => x != null).length;
  if (geoCount > 0 && geoCount < 3) {
    ctx.addIssue({ code: 'custom', message: 'geo_lat, geo_lng, and geo_radius must all be provided together', path: ['geo_lat'] });
  }
});

const patchScheduleSchema = z.object({
  name: z.string().min(1).optional(),
  interval_minutes: z.number().int().min(0).optional(),
  enabled: z.number().int().min(0).max(1).optional(),
  language: z.string().optional().nullable(),
  grid_cell_km: z.number().positive().optional().nullable(),
  geo_lat: z.string().optional().nullable(),
  geo_lng: z.string().optional().nullable(),
  geo_radius: z.number().int().positive().optional().nullable(),
  depth: z.number().int().min(1).max(20).optional().nullable(),
}).superRefine((v, ctx) => {
  const geoCount = [v.geo_lat, v.geo_lng, v.geo_radius].filter(x => x != null).length;
  if (geoCount > 0 && geoCount < 3) {
    ctx.addIssue({ code: 'custom', message: 'geo_lat, geo_lng, and geo_radius must all be provided together', path: ['geo_lat'] });
  }
});

const router = Router();

// GET /status — health + recent runs + auto-analyze backlog/pause
router.get('/status', (_req, res) => {
  const health = getScrapeSchedulerHealth();
  const recentRuns = getRecentRuns({ limit: 20 });
  res.json({ health, recentRuns, autoAnalyze: getAutoAnalyzeHealth() });
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

// POST /auto-analyze/pause — pause auto-analyze independently of scraping
router.post('/auto-analyze/pause', (_req, res) => {
  setAutoAnalyzePaused(true);
  res.json(getAutoAnalyzeHealth());
});

// POST /auto-analyze/resume — resume + kick the drain
router.post('/auto-analyze/resume', (_req, res) => {
  setAutoAnalyzePaused(false);
  res.json(getAutoAnalyzeHealth());
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
  const parsed = createScheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return void res.status(400).json({ error: parsed.error.flatten() });
  }
  const d = parsed.data;
  const row = createSchedule({
    name: d.name,
    polygon_json: d.polygon_json,
    business_type: d.business_type,
    interval_minutes: d.interval_minutes,
    enabled: d.enabled,
    kind: d.kind,
    language: d.language,
    grid_cell_km: d.grid_cell_km,
    keyword_query: d.keyword_query,
    geo_lat: d.geo_lat,
    geo_lng: d.geo_lng,
    geo_radius: d.geo_radius,
    depth: d.depth,
  });
  res.status(201).json(row);
});

// PATCH /:id — update subset
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const parsed = patchScheduleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return void res.status(400).json({ error: parsed.error.flatten() });
  }
  const row = updateSchedule(id, parsed.data);
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
