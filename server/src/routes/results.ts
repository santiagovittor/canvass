import { Router } from 'express';
import { getResults } from '../services/results';

const router = Router();

router.get('/', (req, res) => {
  const jobId = req.query.jobId as string;
  const q = req.query.q as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string ?? '1', 10));

  if (!jobId) { res.status(400).json({ error: 'jobId required' }); return; }

  res.json(getResults(jobId, q, page));
});

export default router;
