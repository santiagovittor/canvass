import { Router } from 'express';
import { getJobs, getJobById } from '../services/jobs';
import { cancelJob } from '../services/jobRunner';

const router = Router();

router.get('/', (_req, res) => {
  res.json(getJobs());
});

router.get('/:id', (req, res) => {
  const row = getJobById(req.params.id);
  if (!row) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const cancelled = cancelJob(req.params.id);
  if (!cancelled) { res.status(404).json({ error: 'Job not found or not running' }); return; }
  res.json({ ok: true });
});

export default router;
