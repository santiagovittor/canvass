import { Router } from 'express';
import { startBatch, pauseBatch, resumeBatch, cancelBatch } from '../services/batchOrchestrator';
import { getBatchRun, getBatchItems } from '../db/batch';

const router = Router();

const MAX_BATCH = 200; // safety ceiling; presets are 15/30/60

// Start a batch over a selection of leads. The prepare pipeline runs under bounded
// concurrency + Gemini throttle; passing drafts enqueue into scheduled_sends (the
// governor still meters actual sending). dryRun threads through to the queue rows.
router.post('/', (req, res) => {
  const { businessIds, dryRun } = req.body as { businessIds?: unknown; dryRun?: unknown };
  if (!Array.isArray(businessIds) || businessIds.length === 0 || !businessIds.every(b => typeof b === 'string')) {
    return res.status(400).json({ error: 'businessIds (non-empty string[]) is required' });
  }
  if (businessIds.length > MAX_BATCH) {
    return res.status(400).json({ error: `batch size ${businessIds.length} exceeds max ${MAX_BATCH}` });
  }
  const runId = startBatch(businessIds as string[], dryRun === true);
  res.json({ runId });
});

router.get('/:id', (req, res) => {
  const run = getBatchRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'batch run not found' });
  res.json({ run, items: getBatchItems(req.params.id) });
});

router.post('/:id/pause', (req, res) => {
  if (!pauseBatch(req.params.id)) return res.status(409).json({ error: 'not pausable' });
  res.json({ ok: true });
});

router.post('/:id/resume', (req, res) => {
  if (!resumeBatch(req.params.id)) return res.status(409).json({ error: 'not resumable' });
  res.json({ ok: true });
});

router.post('/:id/cancel', (req, res) => {
  if (!cancelBatch(req.params.id)) return res.status(409).json({ error: 'not cancelable' });
  res.json({ ok: true });
});

export default router;
