import { UTC_MINUS_3_OFFSET_MS } from '../util/time';
import { env } from '../env';

// Single config surface for scheduled-send pacing/caps. A future Settings tab
// reads from here; for now values are constants (env-overridable where noted).

// Rolling 24h cap. Default 15 is correct for a FRESH Gmail sending identity —
// ramp it up gradually (e.g. 15 → 20 → 25 → 30 over weeks of clean sending) as
// the identity warms; 30 is the warmed steady-state. GMAIL_HARD_CEILING is the
// backstop that is never crossed regardless of how this is tuned.
export const DAILY_CAP_ROLLING = env.OUTREACH_DAILY_CAP;
export const GMAIL_HARD_CEILING = 400;

// Randomized inter-send pacing (deliverability: avoid a robotic cadence).
export const PACING_MIN_MS = 5 * 60_000;
export const PACING_MAX_MS = 15 * 60_000;

// America/Argentina/Buenos_Aires has no DST → a fixed offset is correct.
export const TZ_OFFSET_MS = UTC_MINUS_3_OFFSET_MS;

export interface DayWindow { start: string; end: string } // 'HH:MM' BA wall-clock
export interface BusinessTypeWindows { days: number[]; slots: [string, string][] } // day: 0=Sun..6=Sat

// Generic fallback: weekday business hours.
export const GENERIC_BUSINESS_HOURS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

export type BusinessType = 'lawyer' | 'generic';

// Business-type-aware optimal windows. Only lawyers are specialized for now;
// everything else falls back to GENERIC_BUSINESS_HOURS.
export const BUSINESS_TYPE_WINDOWS: Record<'lawyer', BusinessTypeWindows> = {
  // Mid-morning / early-afternoon on Tue/Wed/Thu — outside Monday triage and
  // Friday wind-down, when a lawyer is most likely to read a cold email.
  lawyer: { days: [2, 3, 4], slots: [['10:30', '11:30'], ['13:00', '14:00']] },
};

// Reuses the skill's category keyword map (abogad/jurídic/bufete/legal → lawyer).
export function resolveBusinessType(category: string | null): BusinessType {
  if (category && /abogad|jurídic|juridic|bufete|notari|legal/i.test(category)) return 'lawyer';
  return 'generic';
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Human-readable audit label for the chosen window, e.g.
// 'lawyer Tue/Wed/Thu 10:30-11:30,13:00-14:00' or 'generic Mon-Fri 09:00-18:00'.
export function describeWindow(type: BusinessType): string {
  if (type === 'lawyer') {
    const w = BUSINESS_TYPE_WINDOWS.lawyer;
    const days = w.days.map(d => DAY_ABBR[d]).join('/');
    const slots = w.slots.map(([s, e]) => `${s}-${e}`).join(',');
    return `lawyer ${days} ${slots}`;
  }
  return `generic Mon-Fri ${GENERIC_BUSINESS_HOURS.start}-${GENERIC_BUSINESS_HOURS.end}`;
}
