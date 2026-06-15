import { UTC_MINUS_3_OFFSET_MS } from '../util/time';
import { getNumber, getTime, getWeekdays } from './appSettings';

// Single config surface for scheduled-send pacing/caps. The tunable values now route
// through the live accessor (Settings tab) instead of frozen module-load constants;
// when no override is set the accessor returns the same env/literal as before, so
// behavior is byte-identical. GMAIL_HARD_CEILING stays a static backstop — never UI-
// editable — and the accessor clamps the cap to it regardless of any persisted value.
// Re-exported from the dependency-free leaf so callers (governor) keep importing it
// from here while the value lives in exactly one place.
export { GMAIL_HARD_CEILING } from './outreachConstants';

// Rolling 24h cap. Default 15 = a FRESH Gmail sending identity; ramp up as it warms.
export function getDailyCapRolling(): number { return getNumber('OUTREACH_DAILY_CAP'); }

// Randomized inter-send pacing (deliverability: avoid a robotic cadence).
export function getPacingMinMs(): number { return getNumber('PACING_MIN_MS'); }
export function getPacingMaxMs(): number { return getNumber('PACING_MAX_MS'); }

// America/Argentina/Buenos_Aires has no DST → a fixed offset is correct.
export const TZ_OFFSET_MS = UTC_MINUS_3_OFFSET_MS;

export interface DayWindow { start: string; end: string } // 'HH:MM' BA wall-clock
export interface BusinessTypeWindows { days: number[]; slots: [string, string][] } // day: 0=Sun..6=Sat
export interface GenericWindow { days: number[]; start: string; end: string }

// Generic fallback: weekday business hours — live-editable (days/start/end).
export function getGenericWindow(): GenericWindow {
  return {
    days: getWeekdays('GENERIC_WINDOW_DAYS'),
    start: getTime('GENERIC_WINDOW_START'),
    end: getTime('GENERIC_WINDOW_END'),
  };
}

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
  const g = getGenericWindow();
  return `generic Mon-Fri ${g.start}-${g.end}`;
}
