import { useState, useEffect, useCallback } from 'react';
import { getSettings, updateSettings, resetSetting, type SettingsView, type SettingValue } from '../lib/api';

export interface SaveResult {
  ok: boolean;
  field?: string;   // offending key on a 400
  error?: string;   // human message on a 400
}

// The shared api `request()` throws `Error("<status> <body>")`. Recover the JSON
// `{ field, error }` a 400 carries so the form can show the message inline.
function parseFieldError(err: unknown): SaveResult {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/^\d{3}\s+(\{.*\})$/s);
  if (m) {
    try {
      const body = JSON.parse(m[1]) as { field?: string; error?: string };
      return { ok: false, field: body.field, error: body.error ?? 'invalid value' };
    } catch { /* fall through */ }
  }
  return { ok: false, error: msg };
}

export function useSettings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    getSettings()
      .then(v => { if (!cancelled) { setView(v); setError(null); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  // Bulk-save a group's changed fields. On success reloads the canonical view so
  // values + sources reflect what the server actually stored/clamped.
  const save = useCallback(async (patch: Record<string, SettingValue>): Promise<SaveResult> => {
    try {
      await updateSettings(patch);
      load();
      return { ok: true };
    } catch (err) {
      return parseFieldError(err);
    }
  }, [load]);

  const reset = useCallback(async (key: string): Promise<SaveResult> => {
    try {
      await resetSetting(key);
      load();
      return { ok: true };
    } catch (err) {
      return parseFieldError(err);
    }
  }, [load]);

  return { view, loading, error, reload: load, save, reset };
}
