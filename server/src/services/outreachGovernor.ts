import { rollingSentCount24h, lastSentAtAny } from '../db';
import {
  getDailyCapRolling, GMAIL_HARD_CEILING, getPacingMinMs, getPacingMaxMs, TZ_OFFSET_MS,
  getGenericWindow, BUSINESS_TYPE_WINDOWS, type BusinessType,
} from './outreachSchedulingConfig';

// All "when" values here are TRUE-UTC milliseconds (Date.now() basis). BA wall-clock
// fields are derived by subtracting TZ_OFFSET_MS and reading the UTC getters — BA has
// no DST so a fixed offset is exact.

interface Windows { days: number[]; slots: [string, string][] }

function windowsFor(type: BusinessType): Windows {
  if (type === 'lawyer') return BUSINESS_TYPE_WINDOWS.lawyer;
  const g = getGenericWindow();
  return { days: g.days, slots: [[g.start, g.end]] };
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

// BA day-of-week (0=Sun) and minutes-since-midnight for a true-UTC instant.
function baFields(utcMs: number): { dow: number; minutes: number } {
  const ba = new Date(utcMs - TZ_OFFSET_MS);
  return { dow: ba.getUTCDay(), minutes: ba.getUTCHours() * 60 + ba.getUTCMinutes() };
}

export function withinWindow(whenUtcMs: number, type: BusinessType): boolean {
  const w = windowsFor(type);
  const { dow, minutes } = baFields(whenUtcMs);
  if (!w.days.includes(dow)) return false;
  return w.slots.some(([s, e]) => minutes >= hhmmToMin(s) && minutes < hhmmToMin(e));
}

// Next slot START at-or-after afterUtcMs for this business type. Scans up to 14 BA
// days forward; returns true-UTC ms.
export function nextOptimalWindowUtc(afterUtcMs: number, type: BusinessType): number {
  const w = windowsFor(type);
  const baAfter = new Date(afterUtcMs - TZ_OFFSET_MS);
  for (let d = 0; d <= 14; d++) {
    const day = new Date(baAfter);
    day.setUTCDate(baAfter.getUTCDate() + d);
    day.setUTCHours(0, 0, 0, 0);
    if (!w.days.includes(day.getUTCDay())) continue;
    for (const [start] of w.slots) {
      // day.getTime() carries BA-midnight in its UTC fields; + slot mins (BA wall)
      // + offset → real UTC instant of that slot start.
      const slotUtcMs = day.getTime() + hhmmToMin(start) * 60_000 + TZ_OFFSET_MS;
      if (slotUtcMs >= afterUtcMs) return slotUtcMs;
    }
  }
  return afterUtcMs; // unreachable for any non-empty window within 14 days
}

export function capRemaining(): number {
  return Math.min(getDailyCapRolling(), GMAIL_HARD_CEILING) - rollingSentCount24h();
}

// Real-UTC ms of the most recent send/dryrun, or null. sent_at is UTC-3 shifted,
// so recover the true instant by adding the offset back.
function lastSentRealMs(): number | null {
  const sentAt = lastSentAtAny();
  if (!sentAt) return null;
  return new Date(sentAt).getTime() + TZ_OFFSET_MS;
}

function pacingGapMs(): number {
  const min = getPacingMinMs();
  const max = getPacingMaxMs();
  return min + Math.floor(Math.random() * (max - min));
}

export type GovernDecision =
  | { action: 'send' }
  | { action: 'defer'; untilUtc: string; reason: string };

// Ordered gates: cap → window → pacing. First failing gate defers to the soonest
// time that gate could pass. Never overnight, never over cap, never robotic cadence.
export function governSend(type: BusinessType, nowUtcMs: number): GovernDecision {
  if (capRemaining() <= 0) {
    // Defer past the current window: next slot start after a 1h nudge so we don't
    // re-evaluate inside the same saturated window.
    const untilMs = nextOptimalWindowUtc(nowUtcMs + 60 * 60_000, type);
    return { action: 'defer', untilUtc: new Date(untilMs).toISOString(), reason: 'deferred:cap_reached' };
  }
  if (!withinWindow(nowUtcMs, type)) {
    const untilMs = nextOptimalWindowUtc(nowUtcMs, type);
    return { action: 'defer', untilUtc: new Date(untilMs).toISOString(), reason: 'deferred:outside_window' };
  }
  const last = lastSentRealMs();
  if (last !== null) {
    const nextAllowed = last + pacingGapMs();
    if (nowUtcMs < nextAllowed) {
      return { action: 'defer', untilUtc: new Date(nextAllowed).toISOString(), reason: 'deferred:pacing' };
    }
  }
  return { action: 'send' };
}
