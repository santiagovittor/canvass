import { Router } from 'express';
import { getActiveRuns } from '../services/activeRuns';

const router = Router();

// One-shot hydration of the active-runs strip on client mount (slice 0012). Not a
// poll — live updates arrive over SSE (runs:snapshot + per-run progress events).
router.get('/active', (_req, res) => {
  res.json(getActiveRuns());
});

export default router;
