import { Router } from 'express';
import { getJobs, getJobById } from '../services/jobs';
import { cancelJob, resumeErroredJob } from '../services/jobRunner';

const router = Router();

router.get('/', (_req, res) => {
  res.json(getJobs());
});

router.get('/:id', (req, res) => {
  const row = getJobById(req.params.id);
  if (!row) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json(row);
});

router.post('/:id/resume', (req, res) => {
  const result = resumeErroredJob(req.params.id);
  if (result === 'not_found') { res.status(404).json({ error: 'Job not found' }); return; }
  if (result === 'not_resumable') { res.status(409).json({ error: 'Job is not in a resumable state' }); return; }
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const cancelled = cancelJob(req.params.id);
  if (!cancelled) { res.status(404).json({ error: 'Job not found or not running' }); return; }
  res.json({ ok: true });
});

export default router;
