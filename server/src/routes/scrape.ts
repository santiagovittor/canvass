import { Router } from 'express';
import { z } from 'zod';
import { startJob, B2B_CATEGORIES } from '../services/jobRunner';
import { cellCount, polygonFromBbox } from '../services/grid';
import { resolveAreaToBbox } from '../services/geocoder';

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

// City tiling (slice 0037): a typed area name → bbox → rectangle polygon → the
// same async startJob the polygon path uses. Single keyword = one category per cell.
const CITY_CELL_KM_DEFAULT = 2; // larger than the 0.4 dense-urban polygon default —
// keeps city sweeps to tens of cells (sane job count + gosom-wedge exposure). The UI
// lets the operator lower it for denser coverage (more leads, more jobs, more wedge risk).

const cityResolveSchema = z.object({
  area: z.string().min(1).max(200).trim(),
  countryHint: z.string().max(100).trim().optional(),
  gridCellKm: z.number().min(0.5).max(10).default(CITY_CELL_KM_DEFAULT),
});

// Preview: resolve the name and report the bbox, the human-readable display name
// (so the operator confirms "Orlando, FL" not "Orlando, other"), and the cell count.
router.post('/city/resolve', async (req, res) => {
  const parsed = cityResolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { area, countryHint, gridCellKm } = parsed.data;
  try {
    const { bbox, displayName, kind } = await resolveAreaToBbox(area, countryHint);
    const count = cellCount(bbox, gridCellKm);
    res.json({ bbox, displayName, kind, cellCount: count, totalJobs: count });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

const citySchema = cityResolveSchema.extend({
  keyword: z.string().min(1).max(200).trim(),
  language: z.string().min(2).max(5).default('es'),
});

router.post('/city', async (req, res) => {
  const parsed = citySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { area, countryHint, gridCellKm, keyword, language } = parsed.data;
  try {
    const { bbox, displayName } = await resolveAreaToBbox(area, countryHint);
    const count = cellCount(bbox, gridCellKm); // single keyword → one category per cell
    if (count > 500) {
      res.status(400).json({ error: `Cell count ${count} exceeds maximum of 500. Increase cell size.` });
      return;
    }
    const geometry = polygonFromBbox(bbox);
    // runKind/cityArea tag the run so its job:done writes the coverage registry (slice 0038).
    const jobId = await startJob({
      geometry, searchTerm: keyword, language, gridCellKm, extractEmails: true,
      runKind: 'city', cityArea: displayName,
    });
    res.json({ jobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Geocode failures and the zero-cell guard are user errors, not server faults
    res.status(message.includes('Polygon too small') || message.includes('resolve') ? 400 : 500).json({ error: message });
  }
});

export default router;
