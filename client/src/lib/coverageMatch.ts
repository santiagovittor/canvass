import type { CoverageArea } from './api';

// Coverage warning logic (slice 0038). Pure: given the typed area name and the
// resolved bbox, find an already-scraped area that's the same place (exact
// normalized-name match) or geographically overlaps it.
//
// ponytail: AABB overlap only — no intersection-area %. Flags Miami vs Miami
// Beach as "overlap"; tighten to an area fraction if it misfires.
export type CoverageMatch = { area: CoverageArea; reason: 'exact' | 'overlap' };

interface Bbox { minLat: number; maxLat: number; minLon: number; maxLon: number; }

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function aabbOverlap(a: Bbox, b: Bbox): boolean {
  return a.minLon < b.maxLon && a.maxLon > b.minLon && a.minLat < b.maxLat && a.maxLat > b.minLat;
}

export function findCoverageMatch(
  typed: string,
  bbox: Bbox | null,
  coverage: CoverageArea[],
): CoverageMatch | null {
  const n = norm(typed);
  if (n.length < 2) return null;

  // Exact name match wins (covers the "re-typing the same city" case).
  const exact = coverage.find(c => norm(c.display_name) === n || c.normalized_name === n);
  if (exact) return { area: exact, reason: 'exact' };

  if (!bbox) return null;
  for (const c of coverage) {
    try {
      const cb = JSON.parse(c.bbox_json) as Bbox;
      if (typeof cb?.minLat === 'number' && aabbOverlap(bbox, cb)) return { area: c, reason: 'overlap' };
    } catch { /* skip malformed bbox_json */ }
  }
  return null;
}
