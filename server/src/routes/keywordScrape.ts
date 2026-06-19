import { Router } from 'express';
import { z } from 'zod';
import { runKeywordJobSync } from '../services/jobRunner';

const router = Router();

const instantSchema = z.object({
  query: z.string().min(1).max(500).trim(),
  lang: z.string().min(2).max(10).optional().default('en'),
  depth: z.number().int().min(1).max(20).optional(),
  // geoBias is all-or-nothing by design (nested object) — no superRefine needed
  geoBias: z.object({
    lat: z.string(),
    lon: z.string(),
    radius: z.number().int().positive(),
  }).optional(),
});

router.post('/instant', async (req, res) => {
  const parsed = instantSchema.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({ error: parsed.error.flatten() });
  }
  const { query, lang, depth, geoBias } = parsed.data;
  try {
    const result = await runKeywordJobSync({ query, lang, depth, geoBias });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[keyword-scrape] instant error:', msg);
    res.status(500).json({ error: msg });
  }
});

export default router;
