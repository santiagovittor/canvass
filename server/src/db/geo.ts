// Geo data layer (slice 0038): self-hosted GeoNames gazetteer search + the
// scraped-area coverage registry. Raw prepared statements (the email_validity
// pattern) — importing { sqlite } from ./index guarantees the table DDL in
// index.ts has already run before these statements are prepared.
import { sqlite } from './index';

export interface GeoPlace {
  name: string;
  admin1: string | null;
  country: string | null;
  population: number;
  lat: number;
  lon: number;
}

const stmtSearchAreas = sqlite.prepare<[string, number], {
  name: string; admin1: string | null; country: string | null;
  population: number; lat: number; lon: number;
}>(`
  SELECT name, admin1, country, population, lat, lon
  FROM geo_places
  WHERE ascii_name LIKE ? || '%' COLLATE NOCASE
  ORDER BY population DESC
  LIMIT ?
`);

// Prefix autocomplete ranked by population. No external call — index-backed, sub-ms.
export function searchAreas(prefix: string, limit = 8): GeoPlace[] {
  const q = prefix.trim();
  if (!q) return [];
  return stmtSearchAreas.all(q, limit);
}

export function geoPlacesCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM geo_places').get() as { n: number }).n;
}

export interface ScrapedArea {
  normalized_name: string;
  display_name: string;
  bbox_json: string;
  keyword: string | null;
  language: string | null;
  last_scraped_at: string;
  runs_count: number;
  cumulative_added: number;
  cumulative_deduped: number;
  last_added: number;
  last_deduped: number;
  last_job_id: string | null;
}

const stmtListAreas = sqlite.prepare<[], ScrapedArea>(`
  SELECT normalized_name, display_name, bbox_json, keyword, language, last_scraped_at,
         runs_count, cumulative_added, cumulative_deduped, last_added, last_deduped, last_job_id
  FROM scraped_areas
  ORDER BY last_scraped_at DESC
`);

export function listScrapedAreas(): ScrapedArea[] {
  return stmtListAreas.all();
}

// New (genuinely-inserted) businesses for a job. onConflictDoUpdate does NOT
// touch jobId, so a re-seen place keeps its original job's id — rows still
// carrying THIS jobId are the new ones (slice 0038 diagnosis).
const stmtCountNew = sqlite.prepare<[string], { n: number }>(
  'SELECT COUNT(*) AS n FROM businesses WHERE job_id = ?'
);
export function countNewBusinessesForJob(jobId: string): number {
  return stmtCountNew.get(jobId)?.n ?? 0;
}

const stmtUpsertArea = sqlite.prepare<
  [string, string, string, string, string | null, string | null, string, number, number, number, number, string, string],
  void
>(`
  INSERT INTO scraped_areas (
    id, normalized_name, display_name, bbox_json, keyword, language,
    last_scraped_at, runs_count, cumulative_added, cumulative_deduped,
    last_added, last_deduped, last_job_id, created_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(normalized_name) DO UPDATE SET
    display_name = excluded.display_name,
    bbox_json = excluded.bbox_json,
    keyword = excluded.keyword,
    language = excluded.language,
    last_scraped_at = excluded.last_scraped_at,
    runs_count = scraped_areas.runs_count + 1,
    cumulative_added = scraped_areas.cumulative_added + excluded.cumulative_added,
    cumulative_deduped = scraped_areas.cumulative_deduped + excluded.cumulative_deduped,
    last_added = excluded.last_added,
    last_deduped = excluded.last_deduped,
    last_job_id = excluded.last_job_id
`);

// Upsert a coverage row from a finished city-tiling job. Keyed by normalized
// (lower/trim) display name; re-runs bump runs_count and accumulate counts.
export function upsertScrapedAreaFromJob(input: {
  displayName: string;
  bboxJson: string;
  keyword: string | null;
  language: string | null;
  added: number;
  deduped: number;
  jobId: string;
  completedAt: string;
}): void {
  const normalized = input.displayName.trim().toLowerCase();
  stmtUpsertArea.run(
    crypto.randomUUID(),
    normalized,
    input.displayName,
    input.bboxJson,
    input.keyword,
    input.language,
    input.completedAt,
    input.added,
    input.deduped,
    input.added,
    input.deduped,
    input.jobId,
    input.completedAt,
  );
}
