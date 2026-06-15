import { Router } from 'express';
import {
  getSettings, updateSetting, updateSettings, resetSettingToDefault, SettingsValidationError,
} from '../services/settings';

const router = Router();

// Live config surface for the Settings tab. Reads return every group's fields with
// the current effective value + source (secrets masked). Writes validate against the
// registry; out-of-range / secret writes are 400 with { field, error }.

router.get('/', (_req, res) => {
  res.json(getSettings());
});

// Bulk write: body is a { [key]: value } patch (one group's Save).
router.put('/', (req, res) => {
  const patch = req.body as Record<string, unknown>;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return res.status(400).json({ error: 'body must be a { key: value } object' });
  }
  try {
    res.json({ applied: updateSettings(patch) });
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return res.status(400).json({ field: err.field, error: err.message });
    }
    throw err;
  }
});

// Single-key write: body is { value }.
router.put('/:key', (req, res) => {
  const { value } = req.body as { value?: unknown };
  try {
    res.json({ key: req.params.key, value: updateSetting(req.params.key, value) });
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return res.status(400).json({ field: err.field, error: err.message });
    }
    throw err;
  }
});

router.post('/:key/reset', (req, res) => {
  try {
    res.json({ key: req.params.key, value: resetSettingToDefault(req.params.key) });
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return res.status(400).json({ field: err.field, error: err.message });
    }
    throw err;
  }
});

export default router;
