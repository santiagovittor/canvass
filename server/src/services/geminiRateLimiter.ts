import Bottleneck from 'bottleneck';
import pRetry, { AbortError } from 'p-retry';
import { env } from '../env';
import { reserveGeminiRpd } from '../db';
// Namespace import: appSettings depends on this module too (RPM apply side-effect),
// so the cyclic edge must be a lazy property read, never a load-time binding.
import * as appSettings from './appSettings';

// Thrown when the persisted Pacific-date daily budget is hit. The batch orchestrator
// catches this, pauses the run, and resumes after the midnight-Pacific RPD reset.
export class GeminiRpdExhausted extends Error {
  constructor(
    public readonly count: number,
    public readonly ceiling: number,
    public readonly pacificDate: string,
  ) {
    super(`Gemini daily request budget exhausted (${count}/${ceiling}) for ${pacificDate}`);
    this.name = 'GeminiRpdExhausted';
  }
}

// RPM enforced in-memory: a reservoir of GEMINI_RPM refilled every 60s, plus minTime
// spacing and a single in-flight call so even a burst can't exceed RPM in the window.
const RPM = env.GEMINI_RPM;
const limiter = new Bottleneck({
  reservoir: RPM,
  reservoirRefreshAmount: RPM,
  reservoirRefreshInterval: 60_000,
  minTime: Math.ceil(60_000 / RPM),
  maxConcurrent: 1,
});

// Live RPM retune from the Settings tab. Updates the reservoir + spacing in place so
// a new rate takes effect on the next refresh window — no restart, no re-import.
export function applyRpm(rpm: number): void {
  if (!Number.isFinite(rpm) || rpm < 1) return;
  void limiter.updateSettings({
    reservoir: rpm,
    reservoirRefreshAmount: rpm,
    minTime: Math.ceil(60_000 / rpm),
  });
}

// Google resets RPD at midnight Pacific. en-CA yields YYYY-MM-DD.
export function pacificDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}

// @google/generative-ai surfaces HTTP status on .status, or embedded in the message
// (e.g. "[429 Too Many Requests]"). Retry only on 429 / 5xx; all else aborts.
function extractStatus(err: unknown): number | null {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number }; message?: string };
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.status === 'number') return e.response.status;
  const m = typeof e?.message === 'string' ? e.message.match(/\[(\d{3})\b/) : null;
  return m ? Number(m[1]) : null;
}
function isRetryable(err: unknown): boolean {
  const s = extractStatus(err);
  return s === 429 || (s !== null && s >= 500 && s <= 599);
}

let calls = 0;
export function geminiCallCount(): number {
  return calls;
}

// Wrap the single generateContent call at each Gemini site. RPD is reserved once per
// logical call (resume-safe; retries ride the margin). RPM + 429/5xx retry-with-backoff
// happen inside Bottleneck so retries are themselves rate-limited (no 429 storm).
export async function withGeminiRate<T>(fn: () => Promise<T>, label = 'gemini'): Promise<T> {
  if (!env.GEMINI_API_KEY) return fn(); // unconfigured callers degrade exactly as before

  const date = pacificDate();
  const rpd = appSettings.getNumber('GEMINI_RPD');
  const reserved = reserveGeminiRpd(date, rpd);
  if (!reserved.ok) throw new GeminiRpdExhausted(reserved.count, rpd, date);

  return pRetry(
    () => limiter.schedule(async () => {
      calls++;
      console.log(`[gemini] ${label} call #${calls} @ ${new Date().toISOString()} (rpd ${reserved.count}/${rpd})`);
      try {
        return await fn();
      } catch (err) {
        // Non-retryable (other 4xx, parse/logic) → abort: p-retry rejects with the
        // original error, preserving each caller's existing degradation behavior.
        if (!isRetryable(err)) throw new AbortError(err instanceof Error ? err : new Error(String(err)));
        throw err; // retryable → backoff + jitter, re-scheduled through the limiter
      }
    }),
    { retries: 4, minTimeout: 1000, factor: 2, randomize: true },
  );
}
