import { sqlite } from './index';

// Statements are prepared lazily (inside each function) because the
// `businesses` table is created by runMigrations() at boot, after module load.

const HAS_EMAIL = `(emails_json IS NOT NULL AND emails_json != '[]')`;
const CONTACTED = `outreach_status IN ('contacted','replied','converted')`;
// Real replies only: converted always counts; 'auto'/'unknown' excluded.
// COALESCE keeps unclassified legacy rows counting until the retro pass lands.
const replied = (p = '') =>
  `(${p}outreach_status = 'converted' OR (${p}outreach_status = 'replied' AND COALESCE(${p}reply_type,'real') = 'real'))`;
const REPLIED = replied();
const ZONE = `COALESCE(NULLIF(loc_neighbourhood,''), NULLIF(loc_city,''))`;

export interface KpiCounts {
  totalLeads: number;
  withEmail: number;
  contactedAll: number;
  replied: number;
  readyLeads: number;
}

export function getKpiCounts(): KpiCounts {
  const row = sqlite.prepare(`
    SELECT
      COUNT(*) AS totalLeads,
      COALESCE(SUM(CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END), 0) AS withEmail,
      COALESCE(SUM(CASE WHEN ${CONTACTED} THEN 1 ELSE 0 END), 0) AS contactedAll,
      COALESCE(SUM(CASE WHEN ${REPLIED} THEN 1 ELSE 0 END), 0) AS replied,
      COALESCE(SUM(CASE WHEN ${HAS_EMAIL} AND outreach_status IS NULL THEN 1 ELSE 0 END), 0) AS readyLeads
    FROM businesses
  `).get() as KpiCounts;
  return row;
}

export interface OpenStats { trackedSends: number; openedSends: number }

export function getOpenStats(): OpenStats {
  const trackedSends = (sqlite.prepare(`
    SELECT COUNT(*) AS n FROM email_sends WHERE status = 'sent' AND tracking_token IS NOT NULL
  `).get() as { n: number }).n;
  const openedSends = (sqlite.prepare(`
    SELECT COUNT(DISTINCT send_id) AS n FROM email_opens
  `).get() as { n: number }).n;
  return { trackedSends, openedSends };
}

export interface DailySendRow { day: string; n: number }

// All-time daily counts of successful sends. sent_at is stored as a UTC-3
// shifted ISO string, so substr(...,1,10) is already the local calendar day.
export function getDailySends(): DailySendRow[] {
  return sqlite.prepare(`
    SELECT substr(sent_at, 1, 10) AS day, COUNT(*) AS n
    FROM email_sends
    WHERE status = 'sent'
    GROUP BY day
    ORDER BY day ASC
  `).all() as DailySendRow[];
}

// Send days for businesses that later replied/converted — used for
// response-rate-by-weekday analysis.
export function getRepliedSendDays(): DailySendRow[] {
  return sqlite.prepare(`
    SELECT substr(es.sent_at, 1, 10) AS day, COUNT(DISTINCT es.business_id) AS n
    FROM email_sends es
    JOIN businesses b ON b.id = es.business_id
    WHERE es.status = 'sent' AND ${replied('b.')}
    GROUP BY day
  `).all() as DailySendRow[];
}

export interface GeoPoint { lat: number; lng: number; e: number; c: number }

export function getGeoPoints(): GeoPoint[] {
  return sqlite.prepare(`
    SELECT
      latitude AS lat,
      longitude AS lng,
      CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END AS e,
      CASE WHEN ${CONTACTED} THEN 1 ELSE 0 END AS c
    FROM businesses
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `).all() as GeoPoint[];
}

export interface MatrixRow { category: string; zone: string; leads: number; withEmail: number; contacted: number; replied: number }

export function getCategoryZoneMatrix(): MatrixRow[] {
  return sqlite.prepare(`
    SELECT
      category,
      ${ZONE} AS zone,
      COUNT(*) AS leads,
      COALESCE(SUM(CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END), 0) AS withEmail,
      COALESCE(SUM(CASE WHEN ${CONTACTED} THEN 1 ELSE 0 END), 0) AS contacted,
      COALESCE(SUM(CASE WHEN ${REPLIED} THEN 1 ELSE 0 END), 0) AS replied
    FROM businesses
    WHERE category IS NOT NULL AND category != '' AND ${ZONE} IS NOT NULL
    GROUP BY category, zone
  `).all() as MatrixRow[];
}

// ── Windowed aggregates (slice 0039). The all-time DB is dominated by the
// original Buenos Aires scrape, so all-time yields never move. These window by
// date so a recent scrape/send visibly shifts the numbers.
// ponytail: one YYYY-MM-DD cutoff serves both scraped_at (UTC) and sent_at
// (UTC-3); the 3h skew is immaterial at a 30/90-day window. `until` excludes its
// own day — pass it for the prior window in a delta, omit for an open window.

export interface EmailFoundRow { category: string; zone: string; leads: number; withEmail: number }

// Email-found rate by category × zone, windowed by scraped_at.
export function getEmailFoundMatrix(since: string, until?: string): EmailFoundRow[] {
  const range = until ? `AND scraped_at >= ? AND scraped_at < ?` : `AND scraped_at >= ?`;
  const args = until ? [since, until] : [since];
  return sqlite.prepare(`
    SELECT
      category,
      ${ZONE} AS zone,
      COUNT(*) AS leads,
      COALESCE(SUM(CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END), 0) AS withEmail
    FROM businesses
    WHERE category IS NOT NULL AND category != '' AND ${ZONE} IS NOT NULL ${range}
    GROUP BY category, zone
  `).all(...args) as EmailFoundRow[];
}

export interface ResponseRow { category: string; zone: string; sends: number; replies: number }

// Response rate by category × zone, windowed by sent_at: `sends` = distinct
// businesses contacted in the window, `replies` = of those, the ones now flagged
// a real reply. Only status='sent' rows count (dryrun/legacy excluded).
export function getResponseMatrix(since: string, until?: string): ResponseRow[] {
  const range = until ? `AND es.sent_at >= ? AND es.sent_at < ?` : `AND es.sent_at >= ?`;
  const args = until ? [since, until] : [since];
  return sqlite.prepare(`
    SELECT
      b.category AS category,
      ${ZONE} AS zone,
      COUNT(DISTINCT es.business_id) AS sends,
      COUNT(DISTINCT CASE WHEN ${replied('b.')} THEN es.business_id END) AS replies
    FROM email_sends es
    JOIN businesses b ON b.id = es.business_id
    WHERE es.status = 'sent'
      AND b.category IS NOT NULL AND b.category != '' AND ${ZONE} IS NOT NULL ${range}
    GROUP BY category, zone
  `).all(...args) as ResponseRow[];
}

export interface CategoryYieldRow { category: string; leads: number; withEmail: number }

export function getCategoryYields(): CategoryYieldRow[] {
  return sqlite.prepare(`
    SELECT category, COUNT(*) AS leads,
      COALESCE(SUM(CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END), 0) AS withEmail
    FROM businesses
    WHERE category IS NOT NULL AND category != ''
    GROUP BY category
  `).all() as CategoryYieldRow[];
}

export interface BandYieldRow { ratingBand: string; reviewBand: string; leads: number; withEmail: number }

export function getBandYields(): BandYieldRow[] {
  return sqlite.prepare(`
    SELECT
      CASE
        WHEN rating < 4.0 THEN 'below 4.0'
        WHEN rating <= 4.3 THEN '4.0–4.3'
        WHEN rating <= 4.7 THEN '4.4–4.7'
        ELSE '4.8–5.0'
      END AS ratingBand,
      CASE
        WHEN review_count < 20 THEN 'under 20'
        WHEN review_count <= 80 THEN '20–80'
        WHEN review_count <= 200 THEN '81–200'
        ELSE '200+'
      END AS reviewBand,
      COUNT(*) AS leads,
      COALESCE(SUM(CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END), 0) AS withEmail
    FROM businesses
    WHERE rating IS NOT NULL AND review_count IS NOT NULL
    GROUP BY ratingBand, reviewBand
  `).all() as BandYieldRow[];
}
