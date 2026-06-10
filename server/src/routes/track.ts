import { Router } from 'express';
import { recordOpen } from '../services/openTracker';

// 1x1 transparent GIF
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const router = Router();

router.get('/:token.gif', (req, res) => {
  recordOpen(req.params.token, req.get('user-agent') ?? null);
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(GIF);
});

export default router;
