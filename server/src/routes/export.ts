import { Router } from 'express';
import { exportToSheets, exportFilteredToSheets } from '../services/sheets';
import { parseFilters } from './businesses';

const router = Router();

router.post('/sheets', async (_req, res) => {
  try {
    const count = await exportToSheets();
    res.json({ ok: true, rowsExported: count });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    res.status(500).json({ error: message });
  }
});

router.post('/sheets/explorer', async (req, res) => {
  try {
    const filters = parseFilters(req.body ?? {});
    const count = await exportFilteredToSheets(filters);
    res.json({ ok: true, rowsExported: count });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    res.status(500).json({ error: message });
  }
});

export default router;
