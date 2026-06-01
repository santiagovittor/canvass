import { Router } from 'express';
import { register } from '../sse';

const router = Router();

router.get('/', (req, res) => {
  register(res);
});

export default router;
