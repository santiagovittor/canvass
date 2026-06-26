import { Router } from 'express';
import { searchAreas } from '../services/geocoder';
import { listScrapedAreas } from '../db/geo';

// Geo UX endpoints (slice 0038): area autocomplete (GeoNames-backed) + the
// scraped-area coverage registry read model.
const router = Router();

// GET /api/geo/autocomplete?q=san → population-ranked places for the area input.
router.get('/autocomplete', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json({ results: searchAreas(q) });
});

// GET /api/geo/coverage → all areas swept via city-tiling, most-recent first.
router.get('/coverage', (_req, res) => {
  res.json({ areas: listScrapedAreas() });
});

export default router;
