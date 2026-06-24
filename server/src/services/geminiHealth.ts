import { broadcast } from '../sse';
import { getGeminiRpd } from '../db';
import { getNumber } from './appSettings';
import type { GeminiErrorDesc } from './geminiRateLimiter';

// Single authority for "is Gemini healthy?" — feeds the always-on client health chip
// and the connect-time SSE snapshot. Tracks two independent exhaustion sources:
//   • provider-side 429 RESOURCE_EXHAUSTED (Google billing/quota) — latched here.
//   • the app's own daily request budget (GEMINI_RPD) — read live from the DB counter.
// "low" is the beforehand signal: the daily budget is ≥80% spent, so the operator can
// pace/top up before calls start failing. Provider exhaustion has no pre-signal (we
// only learn of it on a 429), so the RPD gauge is the honest early-warning proxy.

const LOW_THRESHOLD = 0.8;

export type GeminiHealthStatus = 'healthy' | 'low' | 'exhausted';
export interface GeminiHealth {
  status: GeminiHealthStatus;
  rpdCount: number;
  rpdCeiling: number;
  provider: { exhausted: boolean; since: number | null; reason: string | null };
}

let providerExhaustedSince: number | null = null;
let providerReason: string | null = null;
let lastStatus: GeminiHealthStatus | null = null;

// Google resets RPD at midnight Pacific. en-CA yields YYYY-MM-DD. (Mirrors the helper
// in geminiRateLimiter; duplicated here to keep this module free of a runtime cycle.)
function pacificDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}

export function geminiHealthSnapshot(): GeminiHealth {
  const rpdCeiling = getNumber('GEMINI_RPD');
  const rpdCount = getGeminiRpd(pacificDate());
  let status: GeminiHealthStatus;
  if (providerExhaustedSince !== null || (rpdCeiling > 0 && rpdCount >= rpdCeiling)) {
    status = 'exhausted';
  } else if (rpdCeiling > 0 && rpdCount / rpdCeiling >= LOW_THRESHOLD) {
    status = 'low';
  } else {
    status = 'healthy';
  }
  return {
    status,
    rpdCount,
    rpdCeiling,
    provider: { exhausted: providerExhaustedSince !== null, since: providerExhaustedSince, reason: providerReason },
  };
}

export function isGeminiExhausted(): boolean {
  return providerExhaustedSince !== null;
}

// Broadcast only on a status transition (or when forced) to keep the SSE stream quiet
// while the counter ticks within the same band.
function emit(force: boolean): void {
  const snap = geminiHealthSnapshot();
  if (force || snap.status !== lastStatus) {
    broadcast('gemini:health', snap);
  }
  lastStatus = snap.status;
}

// Provider-side 429 RESOURCE_EXHAUSTED, observed only after the retry budget is spent.
// Latches until a later call succeeds; broadcasts once on the entering transition.
export function markGeminiExhausted(desc: GeminiErrorDesc): void {
  const wasExhausted = providerExhaustedSince !== null;
  if (!wasExhausted) {
    providerExhaustedSince = Date.now();
    providerReason = desc.reason;
  }
  emit(!wasExhausted);
}

// A successful Gemini call clears any latched provider exhaustion (auto-recovery) and
// refreshes the rpd-driven band. Cheap; called after every successful call.
export function markGeminiSuccess(): void {
  if (providerExhaustedSince !== null) {
    providerExhaustedSince = null;
    providerReason = null;
    emit(true); // recovered
  } else {
    emit(false); // ordinary refresh, transition-only
  }
}

// Refresh the rpd-driven band without touching provider state — used on the RPD
// reserve-fail path so the chip flips to "exhausted" as the budget tops out.
export function refreshGeminiHealth(): void {
  emit(false);
}
