import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, or, like, isNotNull, gte, eq, asc, desc, sql } from 'drizzle-orm';
import * as schema from './schema';
import { businesses, scrapeJobs } from './schema';
import { env } from '../env';
import path from 'path';
import fs from 'fs';

const dbPath = path.isAbsolute(env.DATABASE_URL)
  ? env.DATABASE_URL
  : path.resolve(__dirname, '../../..', env.DATABASE_URL);
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS email_sends (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    status TEXT NOT NULL,
    error_text TEXT
  );
  CREATE INDEX IF NOT EXISTS email_sends_business_id_idx ON email_sends(business_id);
  CREATE TABLE IF NOT EXISTS outreach_drafts (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    is_ai_draft INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id TEXT NOT NULL,
    category TEXT,
    category_bucket TEXT NOT NULL,
    top_gap TEXT,
    neighbourhood TEXT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_opens (
    id TEXT PRIMARY KEY,
    send_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS email_opens_send_id_idx ON email_opens(send_id);
  CREATE INDEX IF NOT EXISTS email_opens_business_id_idx ON email_opens(business_id);
`);

// Must run before any prepared statement references top_gap
const draftCols = (sqlite.prepare('PRAGMA table_info(outreach_drafts)').all() as { name: string }[]).map(r => r.name);
if (!draftCols.includes('top_gap')) {
  sqlite.exec('ALTER TABLE outreach_drafts ADD COLUMN top_gap TEXT');
}

// Must run before stmtInsertSend is prepared
const sendCols = (sqlite.prepare('PRAGMA table_info(email_sends)').all() as { name: string }[]).map(r => r.name);
if (!sendCols.includes('tracking_token')) {
  sqlite.exec('ALTER TABLE email_sends ADD COLUMN tracking_token TEXT');
}
sqlite.exec('CREATE INDEX IF NOT EXISTS email_sends_tracking_token_idx ON email_sends(tracking_token)');

export const db = drizzle(sqlite, { schema });
export { sqlite };

export interface BusinessFilters {
  search?: string;
  locCountry?: string;
  locState?: string;
  locCity?: string;
  category?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasWebsite?: boolean;
  hasSocial?: boolean;
  minRating?: number;
  orderBy?: 'name' | 'rating' | 'reviewCount' | 'scraped_at';
  orderDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

function buildWhere(filters: Omit<BusinessFilters, 'page' | 'pageSize' | 'orderBy'>) {
  const { search, locCountry, locState, locCity, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating } = filters;
  return and(
    search ? or(like(businesses.name, `%${search}%`), like(businesses.address, `%${search}%`)) : undefined,
    locCountry ? eq(businesses.locCountry, locCountry) : undefined,
    locState ? eq(businesses.locState, locState) : undefined,
    locCity ? eq(businesses.locCity, locCity) : undefined,
    category ? eq(businesses.category, category) : undefined,
    hasEmail ? and(isNotNull(businesses.emailsJson), sql`${businesses.emailsJson} != '[]'`) : undefined,
    hasPhone ? isNotNull(businesses.phone) : undefined,
    hasWebsite ? isNotNull(businesses.website) : undefined,
    hasSocial ? or(
      isNotNull(businesses.instagram), isNotNull(businesses.facebook),
      isNotNull(businesses.twitter), isNotNull(businesses.tiktok),
      isNotNull(businesses.linkedin), isNotNull(businesses.youtube),
    ) : undefined,
    minRating !== undefined ? gte(businesses.rating, minRating) : undefined,
  );
}

export function queryBusinesses(filters: BusinessFilters = {}) {
  const { orderBy = 'scraped_at', orderDir = 'desc', page = 1, pageSize = 50 } = filters;

  const where = buildWhere(filters);

  const orderColMap = {
    name: businesses.name,
    rating: businesses.rating,
    reviewCount: businesses.reviewCount,
    scraped_at: businesses.scrapedAt,
  };
  const orderCol = orderColMap[orderBy];
  const offset = (page - 1) * pageSize;

  const rows = db.select().from(businesses)
    .where(where)
    .orderBy(orderDir === 'asc' ? asc(orderCol) : desc(orderCol))
    .limit(pageSize)
    .offset(offset)
    .all();

  const total = db.select({ n: sql<number>`count(*)` })
    .from(businesses)
    .where(where)
    .get()?.n ?? 0;

  const withEmail = db.select({ n: sql<number>`count(*)` })
    .from(businesses)
    .where(and(where, isNotNull(businesses.emailsJson), sql`${businesses.emailsJson} != '[]'`))
    .get()?.n ?? 0;

  const contacted = db.select({ n: sql<number>`count(*)` })
    .from(businesses)
    .where(and(where, eq(businesses.outreachStatus, 'contacted')))
    .get()?.n ?? 0;

  return { rows, total, withEmail, contacted };
}

export function updateOutreach(id: string, status: string | null, note?: string | null) {
  return db.update(businesses)
    .set({
      outreachStatus: status,
      ...(note !== undefined ? { outreachNote: note } : {}),
    })
    .where(eq(businesses.id, id))
    .returning()
    .get() ?? null;
}

export function markOrphanedJobsFailed(): void {
  db.update(scrapeJobs)
    .set({ status: 'error', errorMessage: 'Server restarted' })
    .where(or(eq(scrapeJobs.status, 'running'), eq(scrapeJobs.status, 'enriching')))
    .run();
}

export function getDistinctCategories(): string[] {
  return db
    .select({ category: businesses.category })
    .from(businesses)
    .where(isNotNull(businesses.category))
    .groupBy(businesses.category)
    .orderBy(asc(businesses.category))
    .all()
    .map(r => r.category as string);
}

export interface LocationHierarchyNode {
  country: string;
  count: number;
  states: { state: string; count: number; cities: { city: string; count: number }[] }[];
}

export function getLocationHierarchy(
  filters: Omit<BusinessFilters, 'page' | 'pageSize' | 'orderBy' | 'locCountry' | 'locState' | 'locCity'>,
): LocationHierarchyNode[] {
  const where = buildWhere({ ...filters, locCountry: undefined, locState: undefined, locCity: undefined });

  const rows = db
    .select({
      country: businesses.locCountry,
      state: businesses.locState,
      city: businesses.locCity,
      n: sql<number>`count(*)`,
    })
    .from(businesses)
    .where(and(where, sql`${businesses.locationEnriched} = 1`, isNotNull(businesses.locCountry)))
    .groupBy(businesses.locCountry, businesses.locState, businesses.locCity)
    .all();

  // Build hierarchy in-memory
  const countryMap = new Map<string, Map<string, Map<string, number>>>();
  for (const row of rows) {
    const country = (row.country as string | null) ?? '';
    const state = (row.state as string | null) ?? '';
    const city = (row.city as string | null) ?? '';
    if (!country) continue;
    if (!countryMap.has(country)) countryMap.set(country, new Map());
    const stateMap = countryMap.get(country)!;
    if (!stateMap.has(state)) stateMap.set(state, new Map());
    stateMap.get(state)!.set(city, (stateMap.get(state)!.get(city) ?? 0) + (row.n as number));
  }

  const result: LocationHierarchyNode[] = [];
  for (const [country, stateMap] of countryMap) {
    let countryCount = 0;
    const states: LocationHierarchyNode['states'] = [];
    for (const [state, cityMap] of stateMap) {
      const cities = Array.from(cityMap.entries())
        .map(([city, count]) => { countryCount += count; return { city, count }; })
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
      const stateCount = cities.reduce((s, c) => s + c.count, 0);
      states.push({ state, count: stateCount, cities });
    }
    states.sort((a, b) => b.count - a.count);
    result.push({ country, count: countryCount, states: states.slice(0, 15) });
  }

  return result.sort((a, b) => b.count - a.count).slice(0, 10);
}

// ── Email outreach helpers ────────────────────────────────────────────────────

export function parseEmails(json: string | null): string[] {
  if (!json || json.trim() === '' || json === '[]') return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (typeof parsed === 'string' && parsed.length > 0) return [parsed];
    return [];
  } catch {
    const raw = json.trim();
    return raw.length > 0 ? [raw] : [];
  }
}

export function validateEmail(addr: string): boolean {
  if (!addr || addr.length < 6 || addr.length > 254) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr)) return false;
  const domain = addr.split('@')[1].toLowerCase();
  const blocked = ['example.com', 'test.com'];
  if (blocked.includes(domain)) return false;
  if (domain.endsWith('.local') || domain.endsWith('.internal')) return false;
  return true;
}

// sent_at is stored as UTC-3 shifted ISO string so that sent_at.slice(0,10)
// always equals todayUtcMinus3(). Never change one without changing the other.
function todayUtcMinus3(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nowUtcMinus3(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
}

export interface OutreachLead {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  emailsJson: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  locCountry: string | null;
  locNeighbourhood: string | null;
  locCity: string | null;
  outreachStatus: string | null;
  valid_email: boolean;
  first_email: string | null;
  latitude: number | null;
  longitude: number | null;
  instagram: string | null;
  facebook: string | null;
  twitter: string | null;
  tiktok: string | null;
  linkedin: string | null;
  youtube: string | null;
  has_draft: boolean;
}

type RawLeadRow = {
  id: string; name: string; address: string | null; phone: string | null;
  website: string | null; emails_json: string | null; category: string | null;
  rating: number | null; review_count: number | null; loc_country: string | null;
  loc_neighbourhood: string | null; loc_city: string | null; outreach_status: string | null;
  latitude: number | null; longitude: number | null;
  instagram: string | null; facebook: string | null; twitter: string | null;
  tiktok: string | null; linkedin: string | null; youtube: string | null;
  has_draft: number;
};

export interface OutreachLeadFilters {
  search?: string;
  country?: string;
  hasWebsite?: boolean;
  category?: string;
  validEmail?: boolean;
}

function buildOutreachWhere(filters: OutreachLeadFilters = {}): { clause: string; params: (string | number)[] } {
  const conditions = [
    `b.emails_json IS NOT NULL`,
    `b.emails_json != '[]'`,
    `b.outreach_status IS NULL`,
  ];
  const params: (string | number)[] = [];
  if (filters.search) {
    conditions.push(`b.name LIKE ?`);
    params.push(`%${filters.search}%`);
  }
  if (filters.country) {
    conditions.push(`b.loc_country = ?`);
    params.push(filters.country);
  }
  if (filters.hasWebsite === true) {
    conditions.push(`(b.website IS NOT NULL AND trim(b.website) != '')`);
  } else if (filters.hasWebsite === false) {
    conditions.push(`(b.website IS NULL OR trim(b.website) = '')`);
  }
  if (filters.category) {
    conditions.push(`b.category = ?`);
    params.push(filters.category);
  }
  if (filters.validEmail === true) {
    conditions.push(`(b.emails_json LIKE '%@%.%')`);
  }
  return { clause: conditions.join(' AND '), params };
}

export function getOutreachLeads(page = 1, pageSize = 25, filters: OutreachLeadFilters = {}): { rows: OutreachLead[]; total: number } {
  const offset = (page - 1) * pageSize;
  const { clause, params } = buildOutreachWhere(filters);

  const leadsSQL = `
    SELECT b.id, b.name, b.address, b.phone, b.website, b.emails_json, b.category, b.rating, b.review_count,
           b.loc_country, b.loc_neighbourhood, b.loc_city, b.outreach_status,
           b.latitude, b.longitude, b.instagram, b.facebook, b.twitter, b.tiktok, b.linkedin, b.youtube,
           CASE WHEN d.business_id IS NOT NULL THEN 1 ELSE 0 END AS has_draft
    FROM businesses b
    LEFT JOIN outreach_drafts d ON b.id = d.business_id
    WHERE ${clause}
    ORDER BY b.scraped_at DESC
    LIMIT ? OFFSET ?
  `;
  const countSQL = `SELECT COUNT(*) AS n FROM businesses b WHERE ${clause}`;

  const raw = sqlite.prepare<(string | number)[], RawLeadRow>(leadsSQL).all(...params, pageSize, offset);
  const total = sqlite.prepare<(string | number)[], { n: number }>(countSQL).get(...params)?.n ?? 0;

  const rows: OutreachLead[] = raw.map(r => {
    const emails = parseEmails(r.emails_json);
    const first = emails[0] ?? null;
    return {
      id: r.id, name: r.name, address: r.address, phone: r.phone,
      website: r.website, emailsJson: r.emails_json, category: r.category,
      rating: r.rating, reviewCount: r.review_count,
      locCountry: r.loc_country, locNeighbourhood: r.loc_neighbourhood,
      locCity: r.loc_city, outreachStatus: r.outreach_status,
      valid_email: first !== null && validateEmail(first),
      first_email: first,
      latitude: r.latitude, longitude: r.longitude,
      instagram: r.instagram, facebook: r.facebook, twitter: r.twitter,
      tiktok: r.tiktok, linkedin: r.linkedin, youtube: r.youtube,
      has_draft: r.has_draft === 1,
    };
  });

  return { rows, total };
}

export function getDistinctOutreachCategories(): string[] {
  return (sqlite.prepare(`
    SELECT DISTINCT category FROM businesses
    WHERE outreach_status IS NULL AND category IS NOT NULL
    AND emails_json IS NOT NULL AND emails_json != '[]'
    ORDER BY category ASC
  `).all() as { category: string }[]).map(r => r.category);
}

const stmtSendCount = sqlite.prepare<[string], { n: number }>(`
  SELECT COUNT(*) AS n FROM email_sends WHERE status = 'sent' AND sent_at LIKE ? || '%'
`);

export function getDailySendCount(): number {
  return stmtSendCount.get(todayUtcMinus3())?.n ?? 0;
}

const stmtInsertSend = sqlite.prepare<[string, string, string, string, string | null, string | null], void>(`
  INSERT INTO email_sends (id, business_id, sent_at, status, error_text, tracking_token) VALUES (?, ?, ?, ?, ?, ?)
`);

export function recordEmailSend(businessId: string, status: 'sent' | 'failed', errorText?: string, trackingToken?: string | null): void {
  // sent_at stored as UTC-3 shifted ISO string — matches todayUtcMinus3() slice prefix
  stmtInsertSend.run(crypto.randomUUID(), businessId, nowUtcMinus3(), status, errorText ?? null, trackingToken ?? null);
}

const stmtFindSendByToken = sqlite.prepare<[string], { id: string; business_id: string }>(`
  SELECT id, business_id FROM email_sends WHERE tracking_token = ?
`);

export function findSendByToken(token: string): { id: string; business_id: string } | undefined {
  return stmtFindSendByToken.get(token);
}

const stmtInsertOpen = sqlite.prepare<[string, string, string, string, string | null], void>(`
  INSERT INTO email_opens (id, send_id, business_id, opened_at, user_agent) VALUES (?, ?, ?, ?, ?)
`);

export function insertEmailOpen(sendId: string, businessId: string, userAgent: string | null): void {
  stmtInsertOpen.run(crypto.randomUUID(), sendId, businessId, nowUtcMinus3(), userAgent);
}

export function markContacted(businessId: string): void {
  // Guard: a concurrent reply (IMAP checker or manual) must not be clobbered by a follow-up send
  sqlite.prepare(`
    UPDATE businesses SET outreach_status = 'contacted'
    WHERE id = ? AND (outreach_status IS NULL OR outreach_status = 'contacted')
  `).run(businessId);
}

// ── Draft persistence ─────────────────────────────────────────────────────────

const stmtUpsertDraft = sqlite.prepare<[string, string, string, string, number, string, string], void>(`
  INSERT INTO outreach_drafts (id, business_id, subject, body, is_ai_draft, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(business_id) DO UPDATE SET
    subject = excluded.subject,
    body = excluded.body,
    is_ai_draft = excluded.is_ai_draft,
    updated_at = excluded.updated_at
`);

const stmtGetDraft = sqlite.prepare<[string], { subject: string; body: string; is_ai_draft: number; top_gap: string | null }>(`
  SELECT subject, body, is_ai_draft, top_gap FROM outreach_drafts WHERE business_id = ?
`);

const stmtDeleteDraft = sqlite.prepare<[string], void>(`
  DELETE FROM outreach_drafts WHERE business_id = ?
`);

export function upsertDraft(businessId: string, subject: string, body: string, isAiDraft: boolean): void {
  const now = new Date().toISOString();
  stmtUpsertDraft.run(crypto.randomUUID(), businessId, subject, body, isAiDraft ? 1 : 0, now, now);
}

export function getDraft(businessId: string): { subject: string; body: string; isAiDraft: boolean; topGap: string | null } | null {
  const row = stmtGetDraft.get(businessId);
  if (!row) return null;
  return { subject: row.subject, body: row.body, isAiDraft: row.is_ai_draft === 1, topGap: row.top_gap ?? null };
}

export function deleteDraft(businessId: string): void {
  stmtDeleteDraft.run(businessId);
}

const stmtSaveTopGap = sqlite.prepare<[string | null, string], void>(
  `UPDATE outreach_drafts SET top_gap = ? WHERE business_id = ?`
);

export function saveDraftTopGap(businessId: string, topGap: string | null): void {
  stmtSaveTopGap.run(topGap, businessId);
}

// ── Few-shot example pool ─────────────────────────────────────────────────────

export function getCategoryBucket(category: string | null): string {
  if (!category) return 'other';
  if (/médic|medic|clínic|clinic|doctor|odontol|dentist|psicol|salud|consultorio|optom|farmac/i.test(category)) return 'health';
  if (/abogad|jurídic|juridic|bufete|notari|legal/i.test(category)) return 'legal';
  if (/restaurant|café|cafe|bar|comida|panadería|panaderia|heladería|heladeria|pizz|sushi|burger|parrilla|delivery|cocina/i.test(category)) return 'food';
  if (/peluquer|estétic|estetic|salón|salon|spa|barber|nail|cosmet|depilac/i.test(category)) return 'beauty';
  if (/gym|gimnasio|pilates|yoga|fitness|studio|crossfit|entrenamiento/i.test(category)) return 'fitness';
  if (/arquitect|contad|ingenier|diseñad|agencia|consul/i.test(category)) return 'professional';
  return 'other';
}

const stmtInsertExample = sqlite.prepare<[string, string | null, string, string | null, string | null, string, string, string], void>(`
  INSERT INTO email_examples (business_id, category, category_bucket, top_gap, neighbourhood, subject, body, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export function saveEmailExample(data: {
  businessId: string;
  category: string | null;
  topGap: string | null;
  neighbourhood: string | null;
  subject: string;
  body: string;
}): void {
  const bucket = getCategoryBucket(data.category);
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  stmtInsertExample.run(data.businessId, data.category, bucket, data.topGap, data.neighbourhood, data.subject, data.body, now);
}

const stmtExactMatch = sqlite.prepare<[string, string], { subject: string; body: string }>(`
  SELECT subject, body FROM email_examples
  WHERE top_gap = ? AND category_bucket = ?
  ORDER BY created_at DESC LIMIT 1
`);
const stmtGapOnly = sqlite.prepare<[string], { subject: string; body: string }>(`
  SELECT subject, body FROM email_examples
  WHERE top_gap = ?
  ORDER BY created_at DESC LIMIT 1
`);

export function getMatchingExample(topGap: string | null, categoryBucket: string): { subject: string; body: string } | null {
  if (!topGap) return null;
  return stmtExactMatch.get(topGap, categoryBucket) ?? stmtGapOnly.get(topGap) ?? null;
}
