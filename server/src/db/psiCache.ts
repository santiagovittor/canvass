import { sqlite } from './index';

export interface PsiData {
  mobileScore: number | null;
  lcp: number | null;      // ms
  tbt: number | null;      // ms
  tti: number | null;      // ms
  mobileFriendly: boolean | null;
  fetchedAt: string;       // ISO — TTL source of truth
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getCachedPsi(url: string): PsiData | null {
  const row = (sqlite.prepare('SELECT psi_json, fetched_at FROM psi_cache WHERE url = ?')
    .get(url) as { psi_json: string; fetched_at: string } | undefined);
  if (!row) return null;
  if (Date.now() - new Date(row.fetched_at).getTime() > TTL_MS) return null;
  try {
    return JSON.parse(row.psi_json) as PsiData;
  } catch {
    return null;
  }
}

export function upsertPsiCache(url: string, data: PsiData): void {
  sqlite.prepare(
    `INSERT INTO psi_cache (url, psi_json, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET psi_json = excluded.psi_json, fetched_at = excluded.fetched_at`,
  ).run(url, JSON.stringify(data), data.fetchedAt);
}
