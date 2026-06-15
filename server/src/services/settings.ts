import {
  effectiveSettings, setSetting, resetSetting, SettingsValidationError,
  type SettingValue,
} from './appSettings';

// Thin service layer over the live accessor so routes obey the folder rules
// (routes → services → accessor/db). All validation/precedence/clamping lives in
// appSettings; this layer only shapes the read model and the bulk-write loop.

export { SettingsValidationError };

export function getSettings(): ReturnType<typeof effectiveSettings> {
  return effectiveSettings();
}

export function updateSetting(key: string, value: unknown): SettingValue {
  return setSetting(key, value);
}

// Bulk apply (one group's "Save"). Validates+applies each key; a SettingsValidationError
// on any key aborts the loop and propagates (route maps it to a 400 with the field).
export function updateSettings(patch: Record<string, unknown>): Record<string, SettingValue> {
  const applied: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(patch)) {
    applied[key] = setSetting(key, value);
  }
  return applied;
}

export function resetSettingToDefault(key: string): SettingValue {
  return resetSetting(key);
}
