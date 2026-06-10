import { Router } from 'express';
import { getAnalytics } from '../services/analytics';

const router = Router();

router.get('/', (_req, res) => {
  try {
    res.json(getAnalytics());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analytics failed';
    res.status(500).json({ error: message });
  }
});

export default router;
