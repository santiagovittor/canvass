import { env } from '../env';
import { getAllAppSettings, upsertAppSetting, deleteAppSetting } from '../db';
import { FIELDS, GROUPS, getField, validatorFor, type SettingField, type SettingValue } from './settingsRegistry';
import { GMAIL_HARD_CEILING } from './outreachConstants';

export type { SettingValue } from './settingsRegistry';
import { signatureHtml, reloadSignature } from './emailSender';
import * as rateLimiter from './geminiRateLimiter';

// Live config accessor. Resolves every tunable as code-default < env (if envVar) <
// db override, then clamps numerics to the field's [min,max] AFTER the merge so a
// persisted value can never exceed its ceiling (the cap's max is GMAIL_HARD_CEILING).
// Behavior is byte-identical to the old hardcoded surface when no db override is set.
//
// This module is the hub of a config cycle (outreachSchedulingConfig + geminiRateLimiter
// both depend on it). It deliberately does NOT import outreachSchedulingConfig — the
// hard ceiling comes from the dependency-free constants leaf (single source, no cycle) —
// and reaches the rate-limiter through a namespace import so the cyclic edge is a lazy
// property read, never a load-time bind.

export class SettingsValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

// db-override cache: key → parsed override value. Hydrated once, invalidated on write
// (settings are read often, written rarely).
let cache: Map<string, SettingValue> | null = null;
function ensureCache(): Map<string, SettingValue> {
  if (cache) return cache;
  const m = new Map<string, SettingValue>();
  for (const { key, valueJson } of getAllAppSettings()) {
    try { m.set(key, JSON.parse(valueJson) as SettingValue); } catch { /* skip corrupt */ }
  }
  cache = m;
  return m;
}
function invalidate(): void { cache = null; }

function envValueFor(field: SettingField): SettingValue | undefined {
  if (!field.envVar) return undefined;
  const v = env[field.envVar];
  return v as SettingValue | undefined;
}

function clampNumber(field: SettingField, n: number): number {
  let v = n;
  if (field.min !== undefined) v = Math.max(field.min, v);
  if (field.max !== undefined) v = Math.min(field.max, v);
  // The cap's field.max IS GMAIL_HARD_CEILING; assert the backstop explicitly so the
  // ceiling holds even if a future registry edit forgets to set max on this key.
  if (field.key === 'OUTREACH_DAILY_CAP') v = Math.min(v, GMAIL_HARD_CEILING);
  return v;
}

type Source = 'default' | 'env' | 'db' | 'file';

function resolveWithSource(key: string): { value: SettingValue; source: Source } {
  const field = getField(key);
  if (!field) throw new Error(`unknown setting key: ${key}`);

  // File-backed (signature): the file (via emailSender's live handle) is the value.
  if (field.fileBacked) return { value: signatureHtml ?? '', source: 'file' };

  const dbVal = ensureCache().get(key);
  if (dbVal !== undefined) {
    return { value: field.type === 'number' ? clampNumber(field, dbVal as number) : dbVal, source: 'db' };
  }
  const envVal = envValueFor(field);
  if (envVal !== undefined) {
    return { value: field.type === 'number' ? clampNumber(field, envVal as number) : envVal, source: 'env' };
  }
  return {
    value: field.type === 'number' ? clampNumber(field, field.default as number) : field.default,
    source: 'default',
  };
}

function resolve(key: string): SettingValue {
  return resolveWithSource(key).value;
}

// ── Typed getters (consumer-facing) ───────────────────────────────────────────
export function getNumber(key: string): number { return resolve(key) as number; }
export function getString(key: string): string { return resolve(key) as string; }
export function getBool(key: string): boolean { return resolve(key) as boolean; }
export function getTime(key: string): string { return resolve(key) as string; }
export function getWeekdays(key: string): number[] { return resolve(key) as number[]; }

// ── Writes ────────────────────────────────────────────────────────────────────
export function setSetting(key: string, raw: unknown): SettingValue {
  const field = getField(key);
  if (!field) throw new SettingsValidationError(key, 'unknown setting');
  if (field.isSecret) throw new SettingsValidationError(key, 'secret keys are read-only (set via .env, restart to apply)');

  const parsed = validatorFor(field).safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'invalid value';
    throw new SettingsValidationError(key, msg);
  }
  const value = parsed.data as SettingValue;

  if (field.fileBacked) {
    // Signature: write the file + reassign the in-memory handle. Not stored in
    // app_settings — the file is the single source of truth, reloaded at boot.
    reloadSignature(value as string);
    return value;
  }

  upsertAppSetting(key, JSON.stringify(value));
  invalidate();

  // Side-effects: rate-limiter reservoir/concurrency must update live (no restart).
  if (key === 'GEMINI_RPM') rateLimiter.applyRpm(value as number);
  if (key === 'GEMINI_MAX_CONCURRENT') rateLimiter.applyConcurrency(value as number);

  return resolve(key);
}

export function resetSetting(key: string): SettingValue {
  const field = getField(key);
  if (!field) throw new SettingsValidationError(key, 'unknown setting');
  if (field.isSecret) throw new SettingsValidationError(key, 'secret keys are read-only');
  if (field.fileBacked) throw new SettingsValidationError(key, 'signature has no default to reset to');

  deleteAppSetting(key);
  invalidate();
  if (key === 'GEMINI_RPM') rateLimiter.applyRpm(resolve(key) as number);
  if (key === 'GEMINI_MAX_CONCURRENT') rateLimiter.applyConcurrency(resolve(key) as number);
  return resolve(key);
}

// ── Read model for the API (GET /api/settings) ────────────────────────────────
export interface EffectiveField {
  key: string;
  label: string;
  type: SettingField['type'];
  group: string;
  unit?: string;
  min?: number;
  max?: number;
  enum?: string[];
  isSecret?: boolean;
  fileBacked?: boolean;
  help?: string;
  value?: SettingValue;                 // omitted for secrets
  source?: Source;                      // omitted for secrets
  secret?: { isSet: boolean; last4: string | null };
}

function maskSecret(field: SettingField): { isSet: boolean; last4: string | null } {
  const raw = field.envVar ? env[field.envVar] : undefined;
  const s = typeof raw === 'string' ? raw : '';
  if (!s) return { isSet: false, last4: null };
  return { isSet: true, last4: s.slice(-4) };
}

export function effectiveSettings(): { groups: { name: string; fields: EffectiveField[] }[] } {
  const byGroup = new Map<string, EffectiveField[]>();
  for (const g of GROUPS) byGroup.set(g, []);

  for (const field of FIELDS) {
    const meta: EffectiveField = {
      key: field.key, label: field.label, type: field.type, group: field.group,
      unit: field.unit, min: field.min, max: field.max, enum: field.enum,
      isSecret: field.isSecret, fileBacked: field.fileBacked, help: field.help,
    };
    if (field.isSecret) {
      meta.secret = maskSecret(field);               // never the plaintext value
    } else {
      const { value, source } = resolveWithSource(field.key);
      meta.value = value;
      meta.source = source;
    }
    byGroup.get(field.group)!.push(meta);
  }

  return { groups: GROUPS.map(name => ({ name, fields: byGroup.get(name)! })) };
}
