import { sqlite } from './index';

// Statements are prepared lazily (inside each function) because the
// `businesses` table is created by runMigrations() at boot, after module load.

const HAS_EMAIL = `(emails_json IS NOT NULL AND emails_json != '[]')`;
const CONTACTED = `outreach_status IN ('contacted','replied','converted')`;
const REPLIED = `outreach_status IN ('replied','converted')`;
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
    WHERE es.status = 'sent' AND b.${REPLIED}
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

export interface MatrixRow { category: string; zone: string; leads: number; withEmail: number; contacted: number }

export function getCategoryZoneMatrix(): MatrixRow[] {
  return sqlite.prepare(`
    SELECT
      category,
      ${ZONE} AS zone,
      COUNT(*) AS leads,
      COALESCE(SUM(CASE WHEN ${HAS_EMAIL} THEN 1 ELSE 0 END), 0) AS withEmail,
      COALESCE(SUM(CASE WHEN ${CONTACTED} THEN 1 ELSE 0 END), 0) AS contacted
    FROM businesses
    WHERE category IS NOT NULL AND category != '' AND ${ZONE} IS NOT NULL
    GROUP BY category, zone
  `).all() as MatrixRow[];
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
