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
// Degraded (all-null) entries are cached briefly so a slow/failing site doesn't
// re-burn the 60s PSI call every scan — but expire fast in case the site speeds up.
const NEG_TTL_MS = 24 * 60 * 60 * 1000;

// A degraded marker: every metric null (written by runPsi on fetch failure).
function isDegraded(d: PsiData): boolean {
  return d.mobileScore === null && d.lcp === null && d.tbt === null
    && d.tti === null && d.mobileFriendly === null;
}

export function getCachedPsi(url: string): PsiData | null {
  const row = (sqlite.prepare('SELECT psi_json, fetched_at FROM psi_cache WHERE url = ?')
    .get(url) as { psi_json: string; fetched_at: string } | undefined);
  if (!row) return null;
  let data: PsiData;
  try {
    data = JSON.parse(row.psi_json) as PsiData;
  } catch {
    return null;
  }
  const ttl = isDegraded(data) ? NEG_TTL_MS : TTL_MS;
  if (Date.now() - new Date(row.fetched_at).getTime() > ttl) return null;
  return data;
}

export function upsertPsiCache(url: string, data: PsiData): void {
  sqlite.prepare(
    `INSERT INTO psi_cache (url, psi_json, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET psi_json = excluded.psi_json, fetched_at = excluded.fetched_at`,
  ).run(url, JSON.stringify(data), data.fetchedAt);
}
