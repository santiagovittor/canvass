import { fetch } from 'undici';
import type { PsiData } from '../db/psiCache';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const RETRY_DELAYS_MS = [1500, 3000, 6000];
const TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractPsiData(body: unknown): PsiData {
  const b = body as Record<string, unknown>;
  const lhr = b.lighthouseResult as Record<string, unknown> | undefined;
  const audits = (lhr?.audits ?? {}) as Record<string, Record<string, unknown>>;
  const categories = (lhr?.categories ?? {}) as Record<string, Record<string, unknown>>;

  const perfScore = categories.performance?.score;
  const mobileScore = typeof perfScore === 'number' ? Math.round(perfScore * 100) : null;

  const lcpVal = audits['largest-contentful-paint']?.numericValue;
  const lcp = typeof lcpVal === 'number' ? Math.round(lcpVal) : null;

  const tbtVal = audits['total-blocking-time']?.numericValue;
  const tbt = typeof tbtVal === 'number' ? Math.round(tbtVal) : null;

  const ttiVal = audits['interactive']?.numericValue;
  const tti = typeof ttiVal === 'number' ? Math.round(ttiVal) : null;

  const vpScore = audits['viewport']?.score;
  const mobileFriendly = typeof vpScore === 'number' ? vpScore === 1 : null;

  return { mobileScore, lcp, tbt, tti, mobileFriendly, fetchedAt: new Date().toISOString() };
}

export async function fetchPsi(finalUrl: string, apiKey: string): Promise<PsiData | null> {
  const url = `${PSI_ENDPOINT}?url=${encodeURIComponent(finalUrl)}&strategy=mobile&key=${encodeURIComponent(apiKey)}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
          console.warn(`[psi] HTTP ${res.status}, retry ${attempt + 1}`);
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        console.error(`[psi] HTTP ${res.status} (non-retryable) for ${finalUrl}`);
        return null;
      }
      const body = await res.json();
      return extractPsiData(body);
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        console.warn(`[psi] network error, retry ${attempt + 1}:`, err);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      console.error(`[psi] failed after all retries for ${finalUrl}:`, err);
      return null;
    }
  }
  return null;
}
