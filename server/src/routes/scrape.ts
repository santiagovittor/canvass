import { Router } from 'express';
import { z } from 'zod';
import { startJob, B2B_CATEGORIES } from '../services/jobRunner';
import { cellCount } from '../services/grid';

const router = Router();

const scrapeSchema = z.object({
  geometry: z.object({
    type: z.string(),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  }),
  searchTerm: z.string().optional().default(''),
  language: z.string().min(2).max(5).default('es'),
  gridCellKm: z.number().min(0.1).max(10).default(0.4),
  extractEmails: z.boolean().default(true),
});

router.post('/', async (req, res) => {
  const parsed = scrapeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { geometry, searchTerm, language, gridCellKm, extractEmails } = parsed.data;

  const lons = geometry.coordinates[0].map(([lon]) => lon);
  const lats = geometry.coordinates[0].map(([, lat]) => lat);
  const bbox = {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLon: Math.min(...lons), maxLon: Math.max(...lons),
  };
  const count = cellCount(bbox, gridCellKm);
  const categoryCount = searchTerm.trim() ? 1 : B2B_CATEGORIES.length;
  const totalJobs = count * categoryCount;

  if (totalJobs > 500) {
    res.status(400).json({ error: `Job count ${totalJobs} exceeds maximum of 500. Reduce the area or increase cell size.` });
    return;
  }

  try {
    const jobId = await startJob({ geometry, searchTerm, language, gridCellKm, extractEmails });
    res.json({ jobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Zero-cell guard and other validation throws are user errors, not server faults
    res.status(message.includes('Polygon too small') ? 400 : 500).json({ error: message });
  }
});

export default router;
