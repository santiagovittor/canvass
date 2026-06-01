import { Router } from 'express';
import { patchOutreach } from '../services/businesses';

const VALID_STATUSES = ['contacted', 'replied', 'converted', 'skip'] as const;

const router = Router();

router.patch('/:id/outreach', (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body as { status?: unknown; note?: unknown };

  if (status !== null && status !== undefined && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')} or null` });
  }

  const row = patchOutreach(id, (status as string | null) ?? null, note as string | null | undefined);
  if (!row) return res.status(404).json({ error: 'Business not found' });
  res.json(row);
});

export default router;
