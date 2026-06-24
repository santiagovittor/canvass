import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, or, like, isNotNull, gte, eq, asc, desc, sql } from 'drizzle-orm';
import * as schema from './schema';
import { businesses } from './schema';
import { env } from '../env';
import { UTC_MINUS_3_OFFSET_MS, todayUtcMinus3, nowUtcMinus3 } from '../util/time';
import path from 'path';
import fs from 'fs';

const dbPath = path.isAbsolute(env.DATABASE_URL)
  ? env.DATABASE_URL
  : path.resolve(__dirname, '../../..', env.DATABASE_URL);
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
// Premium analysis evidence bundles live under <dataDir>/premium/
export const dataDir = dbDir;

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
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Email-validity cache (slice 0013). One row per probed address; avoids re-doing
  -- DNS MX / SMTP RCPT on every batch pass (281 distinct domains across the queue).
  -- source: placeholder (no network) | probe (MX/SMTP) | bounce (DSN-confirmed dead).
  CREATE TABLE IF NOT EXISTS email_validity (
    email TEXT PRIMARY KEY,
    result TEXT NOT NULL,
    mx_ok INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    checked_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_opens_send_id_idx ON email_opens(send_id);
  CREATE INDEX IF NOT EXISTS email_opens_business_id_idx ON email_opens(business_id);
  CREATE TABLE IF NOT EXISTS psi_cache (
    url TEXT PRIMARY KEY,
    psi_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  -- Durable scheduled-send queue. Source of truth for the worker; survives restarts.
  -- subject/body are NOT stored — the worker re-reads the LIVE draft at fire time
  -- and re-gates it (single source of truth). scheduled_at/claimed_at are TRUE UTC
  -- (Date.toISOString()); created_at/updated_at are UTC-3 shifted (house display
  -- convention). The two bases are never compared to each other.
  CREATE TABLE IF NOT EXISTS scheduled_sends (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    claimed_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    business_type TEXT,
    window_label TEXT,
    disposition TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS scheduled_sends_status_idx ON scheduled_sends(status);
  CREATE INDEX IF NOT EXISTS scheduled_sends_business_id_idx ON scheduled_sends(business_id);
  CREATE TABLE IF NOT EXISTS suppression_list (
    email TEXT PRIMARY KEY,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  -- Batch automation: bulk-prepare state machine. See schema.ts for column intent.
  CREATE TABLE IF NOT EXISTS batch_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    size INTEGER NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    skipped_no_evidence INTEGER NOT NULL DEFAULT 0,
    held_generic INTEGER NOT NULL DEFAULT 0,
    queued_for_send INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS batch_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    disposition TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS batch_items_batch_id_idx ON batch_items(batch_id);
  CREATE INDEX IF NOT EXISTS batch_items_state_idx ON batch_items(state);
  -- Persisted Gemini daily-request budget, keyed to Pacific calendar date.
  CREATE TABLE IF NOT EXISTS gemini_rpd (
    pacific_date TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
  -- Per-call Gemini cost ledger. One row per BILLED call (success with usage). The
  -- only durable record of spend — recordCost() previously logged to console only,
  -- so historical per-stage/per-lead cost was unrecoverable after log rotation.
  CREATE TABLE IF NOT EXISTS gemini_cost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    business_id TEXT,
    analysis_id TEXT,
    in_tokens INTEGER NOT NULL DEFAULT 0,
    out_tokens INTEGER NOT NULL DEFAULT 0,
    usd REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS gemini_cost_log_ts_idx ON gemini_cost_log(ts);
  CREATE INDEX IF NOT EXISTS gemini_cost_log_business_id_idx ON gemini_cost_log(business_id);
  -- Live config overrides for the Settings tab. Additive; one row per overridden key.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scrape_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    polygon_json TEXT NOT NULL,
    business_type TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT NOT NULL,
    last_run_status TEXT,
    last_run_added_count INTEGER,
    last_run_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scrape_schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES scrape_schedules(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    added_count INTEGER NOT NULL DEFAULT 0,
    deduped_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS scrape_schedule_runs_schedule_id_idx
    ON scrape_schedule_runs(schedule_id);
  CREATE INDEX IF NOT EXISTS scrape_schedule_runs_status_idx
    ON scrape_schedule_runs(status);
`);

const scheduleCols = (sqlite.prepare('PRAGMA table_info(scrape_schedules)').all() as { name: string }[]).map(r => r.name);
if (!scheduleCols.includes('kind')) {
  sqlite.exec(`ALTER TABLE scrape_schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'polygon'`);
}
if (!scheduleCols.includes('language')) {
  sqlite.exec('ALTER TABLE scrape_schedules ADD COLUMN language TEXT');
}
if (!scheduleCols.includes('grid_cell_km')) {
  sqlite.exec('ALTER TABLE scrape_schedules ADD COLUMN grid_cell_km REAL');
}
if (!scheduleCols.includes('keyword_query')) {
  sqlite.exec('ALTER TABLE scrape_schedules ADD COLUMN keyword_query TEXT');
}
if (!scheduleCols.includes('geo_lat')) {
  sqlite.exec('ALTER TABLE scrape_schedules ADD COLUMN geo_lat TEXT');
}
if (!scheduleCols.includes('geo_lng')) {
  sqlite.exec('ALTER TABLE scrape_schedules ADD COLUMN geo_lng TEXT');
}
if (!scheduleCols.includes('geo_radius')) {
  sqlite.exec('ALTER TABLE scrape_schedules ADD COLUMN geo_radius INTEGER');
}
if (!scheduleCols.includes('depth')) {
  sqlite.exec('ALTER TABLE scrape_schedules ADD COLUMN depth INTEGER');
}

// Per-batch dry-run flag threaded into the durable queue. DEFAULT 0 keeps existing
// and manually-scheduled rows REAL; only a dry-run batch sets it. The worker ORs it
// with env.OUTREACH_DRY_RUN (a row may add dry-safety, never remove it).
const scheduledCols = (sqlite.prepare('PRAGMA table_info(scheduled_sends)').all() as { name: string }[]).map(r => r.name);
if (!scheduledCols.includes('dry_run')) {
  sqlite.exec('ALTER TABLE scheduled_sends ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0');
}
// Convention: 'manual' = user-initiated via /schedule route; window-defer is skipped.
// 'auto' = batch orchestrator; full window/cap/pacing gates apply.
// ALL call sites must pass origin explicitly — never rely on this default.
if (!scheduledCols.includes('origin')) {
  sqlite.exec("ALTER TABLE scheduled_sends ADD COLUMN origin TEXT NOT NULL DEFAULT 'auto'");
}

// Must run before any prepared statement references top_gap or verification_json
const draftCols = (sqlite.prepare('PRAGMA table_info(outreach_drafts)').all() as { name: string }[]).map(r => r.name);
if (!draftCols.includes('top_gap')) {
  sqlite.exec('ALTER TABLE outreach_drafts ADD COLUMN top_gap TEXT');
}
if (!draftCols.includes('verification_json')) {
  sqlite.exec('ALTER TABLE outreach_drafts ADD COLUMN verification_json TEXT');
}

// Must run before stmtInsertSend is prepared
const sendCols = (sqlite.prepare('PRAGMA table_info(email_sends)').all() as { name: string }[]).map(r => r.name);
if (!sendCols.includes('tracking_token')) {
  sqlite.exec('ALTER TABLE email_sends ADD COLUMN tracking_token TEXT');
}
if (!sendCols.includes('verification_override')) {
  sqlite.exec('ALTER TABLE email_sends ADD COLUMN verification_override INTEGER NOT NULL DEFAULT 0');
}
// Correlates a send back to the scheduled_sends row that produced it, so the
// worker's idempotency guard is keyed to THIS scheduled job (not the business) —
// legitimate scheduled follow-ups to an already-contacted business are not skipped.
if (!sendCols.includes('scheduled_send_id')) {
  sqlite.exec('ALTER TABLE email_sends ADD COLUMN scheduled_send_id TEXT');
}
sqlite.exec('CREATE INDEX IF NOT EXISTS email_sends_tracking_token_idx ON email_sends(tracking_token)');
sqlite.exec('CREATE INDEX IF NOT EXISTS email_sends_scheduled_send_id_idx ON email_sends(scheduled_send_id)');

// Must run before stmtInsertExample is prepared. Follow-ups are excluded from
// the few-shot pool that seeds initial-email generation.
const exampleCols = (sqlite.prepare('PRAGMA table_info(email_examples)').all() as { name: string }[]).map(r => r.name);
if (!exampleCols.includes('kind')) {
  sqlite.exec(`ALTER TABLE email_examples ADD COLUMN kind TEXT NOT NULL DEFAULT 'initial'`);
}

const premiumCols = (sqlite.prepare('PRAGMA table_info(premium_analyses)').all() as { name: string }[]).map(r => r.name);
if (!premiumCols.includes('psi_json')) {
  sqlite.exec('ALTER TABLE premium_analyses ADD COLUMN psi_json TEXT');
}
if (!premiumCols.includes('vision_json')) {
  sqlite.exec('ALTER TABLE premium_analyses ADD COLUMN vision_json TEXT');
}

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
      // Manual "Mark replied" = a human read the email → real by definition; also overrides misclassification
      ...(status === 'replied' ? { repliedAt: nowUtcMinus3(), replyType: 'real' as const } : {}),
      ...(note !== undefined ? { outreachNote: note } : {}),
    })
    .where(eq(businesses.id, id))
    .returning()
    .get() ?? null;
}

// website-bearing leads for a finished scrape job. Empty-string websites are
// stored as '' (not NULL), so filter both — `isNotNull` alone would let '' through.
export function getAnalyzableBusinessIdsForJob(jobId: string): string[] {
  return db.select({ id: businesses.id }).from(businesses)
    .where(and(
      eq(businesses.jobId, jobId),
      isNotNull(businesses.website),
      sql`${businesses.website} != ''`,
    ))
    .all().map(r => r.id);
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

export interface LocationHierarchy {
  countries: LocationHierarchyNode[];
  pendingCount: number;
}

export function getLocationHierarchy(
  filters: Omit<BusinessFilters, 'page' | 'pageSize' | 'orderBy' | 'locCountry' | 'locState' | 'locCity'>,
): LocationHierarchy {
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

  // Leads not yet location-enriched (or enriched without a country) would otherwise
  // be invisible in the filter while still appearing in the table
  const pendingCount = db.select({ n: sql<number>`count(*)` })
    .from(businesses)
    .where(and(where, sql`${businesses.locCountry} IS NULL`))
    .get()?.n ?? 0;

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

  return {
    countries: result.sort((a, b) => b.count - a.count).slice(0, 10),
    pendingCount,
  };
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

// Template/placeholder addresses scraped verbatim from site boilerplate
// ("escribí a tuemail@email.com"). Block by LOCAL-PART, never by domain alone —
// email.com / domain.com are real providers, so the junk signal is the local-part.
//
// STRONG: junk on any domain — no real person uses these as a mailbox name.
const PLACEHOLDER_STRONG_RE =
  /^(?:tu-?(?:email|correo|mail)|your-?(?:email|mail|name)|youremailhere|nombre|ejemplo|sample|usuario|prueba|abc|xyz)$/i;
// WEAK: generic words that ARE legitimate mailboxes (info@, mail@) on a real
// domain, but are placeholders when paired with a template domain stem
// (email@email, name@domain, info@example, test@test, user@domain…).
const PLACEHOLDER_WEAK_RE = /^(?:email|correo|mail|name|info|test|user|example)$/i;
const TEMPLATE_DOMAIN_STEM_RE = /^(?:email|correo|mail|domain|dominio|example|ejemplo|test|sample|yourdomain|tudominio)$/i;

export function isPlaceholderEmail(addr: string): boolean {
  const at = addr.indexOf('@');
  if (at < 0) return false;
  const local = addr.slice(0, at).toLowerCase();
  const domainStem = addr.slice(at + 1).toLowerCase().split('.')[0];
  if (PLACEHOLDER_STRONG_RE.test(local)) return true;
  // weak local-part only junk against a template-y domain stem (or an exact echo)
  if (PLACEHOLDER_WEAK_RE.test(local) && (local === domainStem || TEMPLATE_DOMAIN_STEM_RE.test(domainStem))) return true;
  return false;
}

export function validateEmail(addr: string): boolean {
  if (!addr || addr.length < 6 || addr.length > 254) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr)) return false;
  const domain = addr.split('@')[1].toLowerCase();
  const blocked = ['example.com', 'test.com'];
  if (blocked.includes(domain)) return false;
  if (domain.endsWith('.local') || domain.endsWith('.internal')) return false;
  if (isPlaceholderEmail(addr)) return false;
  return true;
}

// ── Email-validity cache (slice 0013) ─────────────────────────────────────────

export type EmailValidity = 'valid' | 'unknown' | 'invalid';

export function getEmailValidity(email: string): { result: EmailValidity; checkedAt: string } | null {
  const row = sqlite.prepare<[string], { result: string; checked_at: string }>(
    `SELECT result, checked_at FROM email_validity WHERE email = ?`
  ).get(email.toLowerCase());
  if (!row) return null;
  return { result: row.result as EmailValidity, checkedAt: row.checked_at };
}

export function upsertEmailValidity(email: string, result: EmailValidity, mxOk: boolean, source: string): void {
  sqlite.prepare(`
    INSERT INTO email_validity (email, result, mx_ok, source, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      result = excluded.result, mx_ok = excluded.mx_ok,
      source = excluded.source, checked_at = excluded.checked_at
  `).run(email.toLowerCase(), result, mxOk ? 1 : 0, source, nowUtcMinus3());
}

// Batch lookup for the lead queue: one query per page instead of N.
export function getEmailValidityMany(emails: string[]): Map<string, EmailValidity> {
  const out = new Map<string, EmailValidity>();
  if (emails.length === 0) return out;
  const lc = [...new Set(emails.map(e => e.toLowerCase()))];
  const placeholders = lc.map(() => '?').join(',');
  const rows = sqlite.prepare(`SELECT email, result FROM email_validity WHERE email IN (${placeholders})`)
    .all(...lc) as { email: string; result: string }[];
  for (const r of rows) out.set(r.email, r.result as EmailValidity);
  return out;
}

// Resolve a lead's deliverability state against a page's pre-loaded validity map
// (built by getEmailValidityMany — one query per page, no N+1): cached probe wins;
// else regex-fail/placeholder → invalid, not-yet-probed → unknown.
function resolveValidity(first: string | null, map: Map<string, EmailValidity>): EmailValidity {
  const cached = first ? map.get(first.toLowerCase()) : undefined;
  return cached ?? (first !== null && validateEmail(first) ? 'unknown' : 'invalid');
}

// All parsed emails for a lead — the send/gate path needs every candidate to rank
// them (slice 0025), not just the first. Light row the BusinessForEmailRow lacks.
export function getBusinessEmails(businessId: string): string[] {
  const r = sqlite.prepare<[string], { emails_json: string | null }>(
    `SELECT emails_json FROM businesses WHERE id = ?`
  ).get(businessId);
  return r ? parseEmails(r.emails_json) : [];
}

// Slice 0025: pick the best-reachable address among a lead's candidates using only
// CACHED validity (valid > unknown > invalid; ties keep original order). Pure — no
// probing — so it is safe inside per-page list queries. The send path
// (selectBestEmail) probes uncached addresses and caches them, so the queue
// converges to the address that actually gets emailed.
const VALIDITY_RANK: Record<EmailValidity, number> = { valid: 0, unknown: 1, invalid: 2 };
export function pickBestCachedEmail(emails: string[], map: Map<string, EmailValidity>): string | null {
  if (emails.length === 0) return null;
  let best = emails[0];
  let bestRank = VALIDITY_RANK[resolveValidity(best, map)];
  for (let i = 1; i < emails.length; i++) {
    const rank = VALIDITY_RANK[resolveValidity(emails[i], map)];
    if (rank < bestRank) { best = emails[i]; bestRank = rank; }
  }
  return best;
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
  email_validity: EmailValidity;
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
  outreachAnalysisJson: string | null;
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
  outreach_analysis_json: string | null;
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
           b.loc_country, b.loc_neighbourhood, b.loc_city, b.outreach_status, b.outreach_analysis_json,
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

  // Batch-load cached probe results for ALL of this page's emails (one query) so
  // pickBestCachedEmail (slice 0025) can rank every candidate, not just the first.
  const validityMap = getEmailValidityMany(raw.flatMap(r => parseEmails(r.emails_json)));

  const rows: OutreachLead[] = raw.map(r => {
    const best = pickBestCachedEmail(parseEmails(r.emails_json), validityMap);
    const validEmail = best !== null && validateEmail(best);
    const email_validity = resolveValidity(best, validityMap);
    return {
      id: r.id, name: r.name, address: r.address, phone: r.phone,
      website: r.website, emailsJson: r.emails_json, category: r.category,
      rating: r.rating, reviewCount: r.review_count,
      locCountry: r.loc_country, locNeighbourhood: r.loc_neighbourhood,
      locCity: r.loc_city, outreachStatus: r.outreach_status,
      valid_email: validEmail,
      email_validity,
      first_email: best,   // slice 0025: now the selected best-reachable address
      latitude: r.latitude, longitude: r.longitude,
      instagram: r.instagram, facebook: r.facebook, twitter: r.twitter,
      tiktok: r.tiktok, linkedin: r.linkedin, youtube: r.youtube,
      has_draft: r.has_draft === 1,
      outreachAnalysisJson: r.outreach_analysis_json,
    };
  });

  return { rows, total };
}

// No-website lane (slice 0007): leads with no website but a phone, untouched.
// These are structurally excluded from getOutreachLeads (which requires an email),
// so they need their own query. Same row shape — the WhatsApp lane reuses the
// outreach_drafts join (has_draft) and the OutreachLead type; email fields are
// empty for these rows by definition.
export function getNoSiteLeads(page = 1, pageSize = 25, filters: { search?: string } = {}): { rows: OutreachLead[]; total: number } {
  const offset = (page - 1) * pageSize;
  const conditions = [
    `(b.website IS NULL OR trim(b.website) = '')`,
    `b.phone IS NOT NULL AND trim(b.phone) != ''`,
    `b.outreach_status IS NULL`,
  ];
  const params: (string | number)[] = [];
  if (filters.search) {
    conditions.push(`b.name LIKE ?`);
    params.push(`%${filters.search}%`);
  }
  const clause = conditions.join(' AND ');

  const leadsSQL = `
    SELECT b.id, b.name, b.address, b.phone, b.website, b.emails_json, b.category, b.rating, b.review_count,
           b.loc_country, b.loc_neighbourhood, b.loc_city, b.outreach_status, b.outreach_analysis_json,
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

  // Batch-load cached probe results for ALL of this page's emails (one query) so
  // pickBestCachedEmail (slice 0025) can rank every candidate. No-site leads have
  // no email by definition, so best stays null here — kept consistent regardless.
  const validityMap = getEmailValidityMany(raw.flatMap(r => parseEmails(r.emails_json)));

  const rows: OutreachLead[] = raw.map(r => {
    const best = pickBestCachedEmail(parseEmails(r.emails_json), validityMap);
    const validEmail = best !== null && validateEmail(best);
    const email_validity = resolveValidity(best, validityMap);
    return {
      id: r.id, name: r.name, address: r.address, phone: r.phone,
      website: r.website, emailsJson: r.emails_json, category: r.category,
      rating: r.rating, reviewCount: r.review_count,
      locCountry: r.loc_country, locNeighbourhood: r.loc_neighbourhood,
      locCity: r.loc_city, outreachStatus: r.outreach_status,
      valid_email: validEmail,
      email_validity,
      first_email: best,   // slice 0025: selected best-reachable address
      latitude: r.latitude, longitude: r.longitude,
      instagram: r.instagram, facebook: r.facebook, twitter: r.twitter,
      tiktok: r.tiktok, linkedin: r.linkedin, youtube: r.youtube,
      has_draft: r.has_draft === 1,
      outreachAnalysisJson: r.outreach_analysis_json,
    };
  });

  return { rows, total };
}

// Mark a no-site lead handled: flip to 'contacted' (drops it from getNoSiteLeads,
// like the email path) and clear its WhatsApp draft.
export function markNoSiteContacted(businessId: string): void {
  markContacted(businessId);
  deleteDraft(businessId);
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

const stmtInsertSend = sqlite.prepare<[string, string, string, string, string | null, string | null, number, string | null], void>(`
  INSERT INTO email_sends (id, business_id, sent_at, status, error_text, tracking_token, verification_override, scheduled_send_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// 'dryrun' = a dry-run transmit: counts toward the governor's cap/pacing during a
// test, but is filterable and excluded from real history/analytics (which filter
// status='sent') and never flips contacted-state. Real send history is untouched.
export function recordEmailSend(businessId: string, status: 'sent' | 'failed' | 'dryrun', errorText?: string, trackingToken?: string | null, verificationOverride?: boolean, scheduledSendId?: string | null): void {
  // sent_at stored as UTC-3 shifted ISO string — matches todayUtcMinus3() slice prefix
  stmtInsertSend.run(crypto.randomUUID(), businessId, nowUtcMinus3(), status, errorText ?? null, trackingToken ?? null, verificationOverride ? 1 : 0, scheduledSendId ?? null);
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

let stmtSaveOutreachAnalysis: import('better-sqlite3').Statement<[string, string], void> | null = null;

export function saveOutreachAnalysis(businessId: string, analysisJson: string): void {
  if (!stmtSaveOutreachAnalysis) {
    stmtSaveOutreachAnalysis = sqlite.prepare<[string, string], void>(
      `UPDATE businesses SET outreach_analysis_json = ? WHERE id = ?`
    );
  }
  stmtSaveOutreachAnalysis.run(analysisJson, businessId);
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

const stmtGetDraft = sqlite.prepare<[string], { subject: string; body: string; is_ai_draft: number; top_gap: string | null; verification_json: string | null }>(`
  SELECT subject, body, is_ai_draft, top_gap, verification_json FROM outreach_drafts WHERE business_id = ?
`);

const stmtDeleteDraft = sqlite.prepare<[string], void>(`
  DELETE FROM outreach_drafts WHERE business_id = ?
`);

export function upsertDraft(businessId: string, subject: string, body: string, isAiDraft: boolean): void {
  const now = new Date().toISOString();
  stmtUpsertDraft.run(crypto.randomUUID(), businessId, subject, body, isAiDraft ? 1 : 0, now, now);
}

export function getDraft(businessId: string): { subject: string; body: string; isAiDraft: boolean; topGap: string | null; verificationJson: string | null } | null {
  const row = stmtGetDraft.get(businessId);
  if (!row) return null;
  return { subject: row.subject, body: row.body, isAiDraft: row.is_ai_draft === 1, topGap: row.top_gap ?? null, verificationJson: row.verification_json ?? null };
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

const stmtSaveVerification = sqlite.prepare<[string | null, string], void>(
  `UPDATE outreach_drafts SET verification_json = ? WHERE business_id = ?`
);

export function saveDraftVerification(businessId: string, json: string | null): void {
  stmtSaveVerification.run(json, businessId);
}

// ── Scheduled sends (durable queue) ───────────────────────────────────────────

// Minimal business row the scheduled-send worker needs (keeps the worker out of
// drizzle — services call repo fns only).
export interface OutreachSendRow {
  id: string;
  name: string;
  category: string | null;
  emailsJson: string | null;
  locCountry: string | null;
  locNeighbourhood: string | null;
  outreachStatus: string | null;
}
const stmtOutreachSendRow = sqlite.prepare<[string], {
  id: string; name: string; category: string | null; emails_json: string | null;
  loc_country: string | null; loc_neighbourhood: string | null; outreach_status: string | null;
}>(`
  SELECT id, name, category, emails_json, loc_country, loc_neighbourhood, outreach_status
  FROM businesses WHERE id = ?
`);
export function getOutreachSendRow(businessId: string): OutreachSendRow | null {
  const r = stmtOutreachSendRow.get(businessId);
  if (!r) return null;
  return {
    id: r.id, name: r.name, category: r.category, emailsJson: r.emails_json,
    locCountry: r.loc_country, locNeighbourhood: r.loc_neighbourhood, outreachStatus: r.outreach_status,
  };
}

// Full business shape the composer needs (mirrors the /generate route's hand-built
// object). Kept here so services call a repo fn instead of reaching into drizzle.
export interface BusinessForEmailRow {
  name: string;
  category: string | null;
  website: string | null;
  locCountry: string | null;
  locNeighbourhood: string | null;
  rating: number | null;
  reviewCount: number | null;
}
const stmtBusinessForEmail = sqlite.prepare<[string], {
  name: string; category: string | null; website: string | null;
  loc_country: string | null; loc_neighbourhood: string | null;
  rating: number | null; review_count: number | null;
}>(`
  SELECT name, category, website, loc_country, loc_neighbourhood, rating, review_count
  FROM businesses WHERE id = ?
`);
export function getBusinessForEmail(businessId: string): BusinessForEmailRow | null {
  const r = stmtBusinessForEmail.get(businessId);
  if (!r) return null;
  return {
    name: r.name, category: r.category, website: r.website,
    locCountry: r.loc_country, locNeighbourhood: r.loc_neighbourhood,
    rating: r.rating, reviewCount: r.review_count,
  };
}

export interface ScheduledSendRow {
  id: string;
  business_id: string;
  scheduled_at: string;       // true UTC ISO
  status: string;             // scheduled | claimed | sent | failed | canceled | skipped | deferred | held
  claimed_at: string | null;  // true UTC ISO
  attempt_count: number;
  last_error: string | null;
  business_type: string | null;
  window_label: string | null;
  disposition: string | null;
  dry_run: number;            // 0|1 — per-batch dry-run; ORed with env.OUTREACH_DRY_RUN by the worker
  origin: string;             // 'manual' | 'auto' — manual rows bypass window-defer; auto rows do not
  created_at: string;
  updated_at: string;
}

const stmtCreateScheduled = sqlite.prepare<[string, string, string, string | null, string | null, number, string, string, string], void>(`
  INSERT INTO scheduled_sends (id, business_id, scheduled_at, business_type, window_label, dry_run, origin, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function createScheduledSend(input: {
  businessId: string;
  scheduledAtUtc: string;
  businessType: string | null;
  windowLabel: string | null;
  dryRun?: boolean;
  origin: 'manual' | 'auto';
}): ScheduledSendRow {
  const id = crypto.randomUUID();
  const now = nowUtcMinus3();
  stmtCreateScheduled.run(id, input.businessId, input.scheduledAtUtc, input.businessType, input.windowLabel, input.dryRun ? 1 : 0, input.origin, now, now);
  return getScheduledSendById(id)!;
}

const stmtGetScheduledById = sqlite.prepare<[string], ScheduledSendRow>(
  `SELECT * FROM scheduled_sends WHERE id = ?`
);
export function getScheduledSendById(id: string): ScheduledSendRow | undefined {
  return stmtGetScheduledById.get(id);
}

// Due = still scheduled and its UTC fire time has passed. nowUtcIso is TRUE UTC.
const stmtDueScheduled = sqlite.prepare<[string], ScheduledSendRow>(`
  SELECT * FROM scheduled_sends WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at ASC
`);
export function getDueScheduledSends(nowUtcIso: string): ScheduledSendRow[] {
  return stmtDueScheduled.all(nowUtcIso);
}

// Business-level dedup guard for enqueue: returns true if any active row exists.
const stmtHasActiveScheduledSend = sqlite.prepare<[string], { id: string }>(
  `SELECT id FROM scheduled_sends WHERE business_id = ? AND status IN ('scheduled','claimed','deferred') LIMIT 1`
);
export function hasActiveScheduledSend(businessId: string): boolean {
  return stmtHasActiveScheduledSend.get(businessId) !== undefined;
}

// Atomic claim — the idempotency primitive. SQLite serializes writers, so among
// overlapping ticks / a restart, exactly one UPDATE flips 'scheduled'→'claimed'.
// changes===1 ⇒ this caller owns the row and may transmit. attempt_count counts
// real transmit attempts only (claim fires immediately before sendEmail).
const stmtClaimScheduled = sqlite.prepare<[string, string, string], void>(`
  UPDATE scheduled_sends
  SET status = 'claimed', claimed_at = ?, attempt_count = attempt_count + 1, updated_at = ?
  WHERE id = ? AND status = 'scheduled'
`);
export function claimScheduledSend(id: string, nowUtcIso: string): boolean {
  return stmtClaimScheduled.run(nowUtcIso, nowUtcMinus3(), id).changes === 1;
}

// Pre-claim terminal/defer transitions stay conditional on status='scheduled' so
// they never pass through 'claimed' (keeps attempt_count to real send attempts)
// and overlapping ticks can't double-apply. Returns changes===1 for the winner.
const stmtResolveFromScheduled = sqlite.prepare<[string, string | null, string | null, string, string], void>(`
  UPDATE scheduled_sends SET status = ?, disposition = ?, last_error = ?, updated_at = ?
  WHERE id = ? AND status = 'scheduled'
`);
export function resolveScheduledFromScheduled(id: string, status: string, disposition: string | null, lastError: string | null): boolean {
  return stmtResolveFromScheduled.run(status, disposition, lastError, nowUtcMinus3(), id).changes === 1;
}

const stmtDeferScheduled = sqlite.prepare<[string, string | null, string, string], void>(`
  UPDATE scheduled_sends SET status = 'scheduled', scheduled_at = ?, last_error = ?, updated_at = ?
  WHERE id = ? AND status = 'scheduled'
`);
export function deferScheduledSend(id: string, newScheduledAtUtc: string, reason: string): boolean {
  return stmtDeferScheduled.run(newScheduledAtUtc, reason, nowUtcMinus3(), id).changes === 1;
}

// Post-claim finalization — this caller already owns the row via claim.
const stmtFinishScheduled = sqlite.prepare<[string, string | null, string | null, string, string], void>(`
  UPDATE scheduled_sends SET status = ?, disposition = ?, last_error = ?, updated_at = ?
  WHERE id = ?
`);
export function finishScheduledSend(id: string, status: string, disposition: string | null, lastError?: string | null): void {
  stmtFinishScheduled.run(status, disposition, lastError ?? null, nowUtcMinus3(), id);
}

// Crash safety: a claim older than the lease is moved to failed and NOT retried —
// a crash between SMTP transmit and status-write is indistinguishable from one
// before transmit, and the rule is never email twice. Surfaced for manual review.
const stmtReapStale = sqlite.prepare<[string, string], void>(`
  UPDATE scheduled_sends
  SET status = 'failed', disposition = 'failed', last_error = 'lease_expired_unknown_disposition', updated_at = ?
  WHERE status = 'claimed' AND claimed_at < ?
`);
export function reapStaleClaims(cutoffUtcIso: string): number {
  return stmtReapStale.run(nowUtcMinus3(), cutoffUtcIso).changes;
}

export interface UpcomingScheduledSend {
  id: string;
  business_id: string;
  business_name: string;
  scheduled_at: string;
  status: string;
  window_label: string | null;
}
const stmtListUpcoming = sqlite.prepare<[], UpcomingScheduledSend>(`
  SELECT s.id, s.business_id, b.name AS business_name, s.scheduled_at, s.status, s.window_label
  FROM scheduled_sends s JOIN businesses b ON b.id = s.business_id
  WHERE s.status IN ('scheduled', 'deferred')
  ORDER BY s.scheduled_at ASC
`);
export function listUpcomingScheduledSends(): UpcomingScheduledSend[] {
  return stmtListUpcoming.all();
}

const stmtCancelScheduled = sqlite.prepare<[string, string], void>(`
  UPDATE scheduled_sends SET status = 'canceled', updated_at = ?
  WHERE id = ? AND status IN ('scheduled', 'deferred')
`);
export function cancelScheduledSend(id: string): boolean {
  return stmtCancelScheduled.run(nowUtcMinus3(), id).changes === 1;
}

const stmtRescheduleScheduled = sqlite.prepare<[string, string, string], void>(`
  UPDATE scheduled_sends SET scheduled_at = ?, status = 'scheduled', updated_at = ?
  WHERE id = ? AND status IN ('scheduled', 'deferred')
`);
export function rescheduleScheduledSend(id: string, newScheduledAtUtc: string): boolean {
  return stmtRescheduleScheduled.run(newScheduledAtUtc, nowUtcMinus3(), id).changes === 1;
}

// ── Scheduler helpers ─────────────────────────────────────────────────────────

// 'superseded' is NOT in the uq_ss_business_active partial unique index
// (which covers scheduled/claimed/deferred only), so after superseding, a new
// scheduled row can immediately be created for the same business.
const stmtSupersedePending = sqlite.prepare<[string, string], void>(`
  UPDATE scheduled_sends SET status = 'superseded', updated_at = ?
  WHERE business_id = ? AND status = 'scheduled'
`);
export function supersedeScheduledSendsForBusiness(businessId: string): number {
  return stmtSupersedePending.run(nowUtcMinus3(), businessId).changes;
}

const stmtCancelByBusiness = sqlite.prepare<[string, string], void>(`
  UPDATE scheduled_sends SET status = 'canceled', updated_at = ?
  WHERE business_id = ? AND status IN ('scheduled', 'deferred')
`);
export function cancelScheduledSendsByBusiness(businessId: string): number {
  return stmtCancelByBusiness.run(nowUtcMinus3(), businessId).changes;
}

const stmtCancelAllPending = sqlite.prepare<[string], void>(`
  UPDATE scheduled_sends SET status = 'canceled', updated_at = ?
  WHERE status IN ('scheduled', 'deferred')
`);
export function cancelAllPendingScheduledSends(): number {
  return stmtCancelAllPending.run(nowUtcMinus3()).changes;
}

// Most recent scheduled_sends row for a business (any status) — drives the per-lead button.
const stmtMostRecentScheduled = sqlite.prepare<[string], ScheduledSendRow>(`
  SELECT * FROM scheduled_sends WHERE business_id = ? ORDER BY created_at DESC LIMIT 1
`);
export function getMostRecentScheduledSend(businessId: string): ScheduledSendRow | null {
  return stmtMostRecentScheduled.get(businessId) ?? null;
}

// Aggregate counts for the health panel.
// deferScheduledSend() keeps status='scheduled'; detect deferred rows via last_error prefix.
// updated_at is stored as nowUtcMinus3(), so LIKE (todayUtcMinus3() || '%') is a correct
// prefix match for "today in UTC-3" — same offset used for both columns and comparison.
const stmtScheduledCounts = sqlite.prepare<[string, string, string, string], {
  scheduled: number; sending: number; sent_today: number;
  deferred: number; failed_today: number; superseded_today: number; canceled_today: number;
}>(`
  SELECT
    SUM(CASE WHEN status = 'scheduled' AND (last_error IS NULL OR last_error NOT LIKE 'deferred:%') THEN 1 ELSE 0 END) AS scheduled,
    SUM(CASE WHEN status = 'claimed'   THEN 1 ELSE 0 END) AS sending,
    SUM(CASE WHEN status = 'sent'      AND updated_at LIKE (? || '%') THEN 1 ELSE 0 END) AS sent_today,
    SUM(CASE WHEN status = 'scheduled' AND last_error LIKE 'deferred:%' THEN 1 ELSE 0 END) AS deferred,
    SUM(CASE WHEN status = 'failed'    AND updated_at LIKE (? || '%') THEN 1 ELSE 0 END) AS failed_today,
    SUM(CASE WHEN status = 'superseded' AND updated_at LIKE (? || '%') THEN 1 ELSE 0 END) AS superseded_today,
    SUM(CASE WHEN status = 'canceled'   AND updated_at LIKE (? || '%') THEN 1 ELSE 0 END) AS canceled_today
  FROM scheduled_sends
`);
export function getScheduledCounts(): {
  scheduled: number; sending: number; sent_today: number;
  deferred: number; failed_today: number; superseded_today: number; canceled_today: number;
} {
  const today = todayUtcMinus3();
  const row = stmtScheduledCounts.get(today, today, today, today);
  return {
    scheduled: row?.scheduled ?? 0,
    sending: row?.sending ?? 0,
    sent_today: row?.sent_today ?? 0,
    deferred: row?.deferred ?? 0,
    failed_today: row?.failed_today ?? 0,
    superseded_today: row?.superseded_today ?? 0,
    canceled_today: row?.canceled_today ?? 0,
  };
}

// Top N upcoming rows (status='scheduled' or 'held') for the queue panel.
// Reuses the existing UpcomingScheduledSend interface (defined above in this file).
const stmtNextScheduled = sqlite.prepare<[number], UpcomingScheduledSend>(`
  SELECT s.id, s.business_id, b.name AS business_name, s.scheduled_at, s.status, s.window_label
  FROM scheduled_sends s JOIN businesses b ON b.id = s.business_id
  WHERE s.status IN ('scheduled', 'held')
  ORDER BY s.scheduled_at ASC
  LIMIT ?
`);
export function getNextScheduledRows(limit: number): UpcomingScheduledSend[] {
  return stmtNextScheduled.all(limit);
}

// Governor counters. A 'dryrun' row counts toward cap/pacing ONLY when the process
// is globally dry (env.OUTREACH_DRY_RUN) — then the last slice's gate exercises
// cap/pacing exactly as a real run would. On a LIVE process (env=false), a per-batch
// dry-run preview produces 'dryrun' rows that must NOT consume real send capacity or
// pace away real sends, so they are excluded. Real 'sent' rows always count.
// Two prepared statements selected by the static env flag (no per-call branching cost).
const stmtRolling24hAll = sqlite.prepare<[string], { n: number }>(`
  SELECT COUNT(*) AS n FROM email_sends WHERE status IN ('sent', 'dryrun') AND sent_at >= ?
`);
const stmtRolling24hSentOnly = sqlite.prepare<[string], { n: number }>(`
  SELECT COUNT(*) AS n FROM email_sends WHERE status = 'sent' AND sent_at >= ?
`);
const stmtRolling24h = env.OUTREACH_DRY_RUN ? stmtRolling24hAll : stmtRolling24hSentOnly;
export function rollingSentCount24h(): number {
  const cutoff = new Date(Date.now() - UTC_MINUS_3_OFFSET_MS - 24 * 60 * 60 * 1000).toISOString();
  return stmtRolling24h.get(cutoff)?.n ?? 0;
}

const stmtLastSentAll = sqlite.prepare<[], { sent_at: string }>(`
  SELECT sent_at FROM email_sends WHERE status IN ('sent', 'dryrun') ORDER BY sent_at DESC LIMIT 1
`);
const stmtLastSentSentOnly = sqlite.prepare<[], { sent_at: string }>(`
  SELECT sent_at FROM email_sends WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1
`);
const stmtLastSentAny = env.OUTREACH_DRY_RUN ? stmtLastSentAll : stmtLastSentSentOnly;
export function lastSentAtAny(): string | null {
  return stmtLastSentAny.get()?.sent_at ?? null;
}

const stmtIsSuppressed = sqlite.prepare<[string], { email: string }>(
  `SELECT email FROM suppression_list WHERE email = ?`
);
export function isSuppressed(email: string): boolean {
  return !!stmtIsSuppressed.get(email.trim().toLowerCase());
}

const stmtAddSuppression = sqlite.prepare<[string, string | null, string], void>(`
  INSERT INTO suppression_list (email, reason, created_at) VALUES (?, ?, ?)
  ON CONFLICT(email) DO NOTHING
`);
export function addSuppression(email: string, reason: string | null): void {
  stmtAddSuppression.run(email.trim().toLowerCase(), reason, nowUtcMinus3());
}

// Secondary idempotency guard keyed to THIS scheduled send (not the business),
// so legitimate scheduled follow-ups to an already-contacted business still send.
const stmtSentForScheduled = sqlite.prepare<[string], { id: string }>(`
  SELECT id FROM email_sends WHERE scheduled_send_id = ? AND status IN ('sent', 'dryrun') LIMIT 1
`);
export function sentRowExistsForScheduledSend(scheduledSendId: string): boolean {
  return !!stmtSentForScheduled.get(scheduledSendId);
}

// ── Gemini daily-request budget (persisted, Pacific-date keyed) ───────────────
// Survives restarts and matches Google's midnight-Pacific RPD reset. reserve is an
// atomic check-and-increment in one transaction so concurrent prepare workers can
// never exceed the ceiling (SQLite serializes the transaction).
const stmtGetRpd = sqlite.prepare<[string], { count: number }>(
  `SELECT count FROM gemini_rpd WHERE pacific_date = ?`
);
const stmtUpsertRpdInc = sqlite.prepare<[string], void>(`
  INSERT INTO gemini_rpd (pacific_date, count) VALUES (?, 1)
  ON CONFLICT(pacific_date) DO UPDATE SET count = count + 1
`);
export function getGeminiRpd(pacificDate: string): number {
  return stmtGetRpd.get(pacificDate)?.count ?? 0;
}
const reserveRpdTxn = sqlite.transaction((pacificDate: string, ceiling: number): { ok: boolean; count: number } => {
  const current = stmtGetRpd.get(pacificDate)?.count ?? 0;
  if (current >= ceiling) return { ok: false, count: current };
  stmtUpsertRpdInc.run(pacificDate);
  return { ok: true, count: current + 1 };
});
export function reserveGeminiRpd(pacificDate: string, ceiling: number): { ok: boolean; count: number } {
  return reserveRpdTxn(pacificDate, ceiling);
}
// Test/ops seam: seed the counter near the ceiling to exercise the exhaustion path.
const stmtSetRpd = sqlite.prepare<[string, number], void>(`
  INSERT INTO gemini_rpd (pacific_date, count) VALUES (?, ?)
  ON CONFLICT(pacific_date) DO UPDATE SET count = excluded.count
`);
export function setGeminiRpd(pacificDate: string, count: number): void {
  stmtSetRpd.run(pacificDate, count);
}

// ── App settings (live config overrides) ─────────────────────────────────────
// value_json is the raw JSON-encoded override; the accessor (appSettings.ts) owns
// typing/precedence/clamping. updated_at is UTC-3 shifted (house display convention).
const stmtGetAllAppSettings = sqlite.prepare<[], { key: string; value_json: string }>(
  `SELECT key, value_json FROM app_settings`
);
export function getAllAppSettings(): { key: string; valueJson: string }[] {
  return stmtGetAllAppSettings.all().map(r => ({ key: r.key, valueJson: r.value_json }));
}

const stmtUpsertAppSetting = sqlite.prepare<[string, string, string], void>(`
  INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
`);
export function upsertAppSetting(key: string, valueJson: string): void {
  stmtUpsertAppSetting.run(key, valueJson, nowUtcMinus3());
}

const stmtDeleteAppSetting = sqlite.prepare<[string], void>(
  `DELETE FROM app_settings WHERE key = ?`
);
export function deleteAppSetting(key: string): void {
  stmtDeleteAppSetting.run(key);
}

// ── Gemini cost ledger ────────────────────────────────────────────────────────
const stmtInsertGeminiCost = sqlite.prepare<
  [string, string, string, string | null, string | null, number, number, number],
  void
>(`
  INSERT INTO gemini_cost_log (ts, label, model, business_id, analysis_id, in_tokens, out_tokens, usd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
export function insertGeminiCost(row: {
  label: string; model: string; businessId: string | null; analysisId: string | null;
  inTokens: number; outTokens: number; usd: number;
}): void {
  stmtInsertGeminiCost.run(
    new Date().toISOString(), row.label, row.model, row.businessId, row.analysisId,
    row.inTokens, row.outTokens, row.usd,
  );
}

// Cost ledger rollups for the cost-report script. `sinceIso` filters by ts (null = all time).
export interface CostRollups {
  byStage: { label: string; calls: number; inTokens: number; outTokens: number; usd: number }[];
  byModel: { model: string; calls: number; usd: number }[];
  byDay: { day: string; calls: number; usd: number }[];
  topLeads: { business_id: string | null; calls: number; usd: number }[];
  total: { calls: number; usd: number };
}
export function getCostRollups(sinceIso: string | null): CostRollups {
  const w = sinceIso ? `WHERE ts >= '${sinceIso}'` : '';
  return {
    byStage: sqlite.prepare(`SELECT label, COUNT(*) calls, SUM(in_tokens) inTokens, SUM(out_tokens) outTokens, ROUND(SUM(usd),4) usd FROM gemini_cost_log ${w} GROUP BY label ORDER BY usd DESC`).all() as CostRollups['byStage'],
    byModel: sqlite.prepare(`SELECT model, COUNT(*) calls, ROUND(SUM(usd),4) usd FROM gemini_cost_log ${w} GROUP BY model ORDER BY usd DESC`).all() as CostRollups['byModel'],
    byDay: sqlite.prepare(`SELECT substr(ts,1,10) day, COUNT(*) calls, ROUND(SUM(usd),4) usd FROM gemini_cost_log ${w} GROUP BY day ORDER BY day DESC LIMIT 14`).all() as CostRollups['byDay'],
    topLeads: sqlite.prepare(`SELECT business_id, COUNT(*) calls, ROUND(SUM(usd),4) usd FROM gemini_cost_log ${w} GROUP BY business_id ORDER BY usd DESC LIMIT 15`).all() as CostRollups['topLeads'],
    total: sqlite.prepare(`SELECT COUNT(*) calls, ROUND(SUM(usd),4) usd FROM gemini_cost_log ${w}`).get() as CostRollups['total'],
  };
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

const stmtInsertExample = sqlite.prepare<[string, string | null, string, string | null, string | null, string, string, string, string], void>(`
  INSERT INTO email_examples (business_id, category, category_bucket, top_gap, neighbourhood, subject, body, created_at, kind)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function saveEmailExample(data: {
  businessId: string;
  category: string | null;
  topGap: string | null;
  neighbourhood: string | null;
  subject: string;
  body: string;
  kind?: 'initial' | 'followup';
}): void {
  const bucket = getCategoryBucket(data.category);
  const now = nowUtcMinus3();
  stmtInsertExample.run(data.businessId, data.category, bucket, data.topGap, data.neighbourhood, data.subject, data.body, now, data.kind ?? 'initial');
}

const stmtExactMatch = sqlite.prepare<[string, string], { subject: string; body: string }>(`
  SELECT subject, body FROM email_examples
  WHERE top_gap = ? AND category_bucket = ? AND kind = 'initial'
  ORDER BY created_at DESC LIMIT 1
`);
const stmtGapOnly = sqlite.prepare<[string], { subject: string; body: string }>(`
  SELECT subject, body FROM email_examples
  WHERE top_gap = ? AND kind = 'initial'
  ORDER BY created_at DESC LIMIT 1
`);

export function getMatchingExample(topGap: string | null, categoryBucket: string): { subject: string; body: string } | null {
  if (!topGap) return null;
  return stmtExactMatch.get(topGap, categoryBucket) ?? stmtGapOnly.get(topGap) ?? null;
}

// ── Follow-up queue ───────────────────────────────────────────────────────────

export interface FollowUpLead extends OutreachLead {
  last_sent_at: string;
  send_count: number;
  // True when at least one 'sent' row carried a tracking_token — i.e. a pixel was
  // actually embedded. Drives the tri-state open indicator (slice 0015): without
  // this, open_count===0 is ambiguous between "not tracked" and "tracked, no open".
  tracked: boolean;
  open_count: number;
  last_opened_at: string | null;
  reply_type: string | null;
}

type RawFollowUpRow = RawLeadRow & {
  last_sent_at: string;
  send_count: number;
  tracked_count: number | null;
  open_count: number;
  last_opened_at: string | null;
  reply_type: string | null;
};

export function getFollowUpLeads(page = 1, pageSize = 25, minDays = 4): { rows: FollowUpLead[]; total: number } {
  const offset = (page - 1) * pageSize;
  // Both sides UTC-3 shifted ISO strings → lexicographic comparison is valid
  const cutoff = new Date(Date.now() - UTC_MINUS_3_OFFSET_MS - minDays * 86_400_000).toISOString();

  const lastSendJoin = `
    JOIN (
      SELECT business_id, MAX(sent_at) AS last_sent_at, COUNT(*) AS send_count,
             SUM(CASE WHEN tracking_token IS NOT NULL THEN 1 ELSE 0 END) AS tracked_count
      FROM email_sends WHERE status = 'sent' GROUP BY business_id
    ) ls ON ls.business_id = b.id
  `;
  // Auto-replies are not engagement — those leads still owe a follow-up
  const whereClause = `
    WHERE (b.outreach_status = 'contacted'
       OR (b.outreach_status = 'replied' AND b.reply_type = 'auto'))
      AND b.follow_up_status IS NULL
      AND ls.last_sent_at < ?
  `;

  const leadsSQL = `
    SELECT b.id, b.name, b.address, b.phone, b.website, b.emails_json, b.category, b.rating, b.review_count,
           b.loc_country, b.loc_neighbourhood, b.loc_city, b.outreach_status, b.outreach_analysis_json,
           b.latitude, b.longitude, b.instagram, b.facebook, b.twitter, b.tiktok, b.linkedin, b.youtube,
           CASE WHEN d.business_id IS NOT NULL THEN 1 ELSE 0 END AS has_draft,
           b.reply_type, ls.last_sent_at, ls.send_count, ls.tracked_count,
           COALESCE(op.open_count, 0) AS open_count, op.last_opened_at
    FROM businesses b
    ${lastSendJoin}
    LEFT JOIN (
      SELECT business_id, COUNT(DISTINCT send_id) AS open_count, MAX(opened_at) AS last_opened_at
      FROM email_opens GROUP BY business_id
    ) op ON op.business_id = b.id
    LEFT JOIN outreach_drafts d ON d.business_id = b.id
    ${whereClause}
    ORDER BY ls.last_sent_at ASC
    LIMIT ? OFFSET ?
  `;
  const countSQL = `SELECT COUNT(*) AS n FROM businesses b ${lastSendJoin} ${whereClause}`;

  const raw = sqlite.prepare<(string | number)[], RawFollowUpRow>(leadsSQL).all(cutoff, pageSize, offset);
  const total = sqlite.prepare<[string], { n: number }>(countSQL).get(cutoff)?.n ?? 0;

  const validityMap = getEmailValidityMany(raw.flatMap(r => parseEmails(r.emails_json)));

  const rows: FollowUpLead[] = raw.map(r => {
    const best = pickBestCachedEmail(parseEmails(r.emails_json), validityMap);
    return {
      id: r.id, name: r.name, address: r.address, phone: r.phone,
      website: r.website, emailsJson: r.emails_json, category: r.category,
      rating: r.rating, reviewCount: r.review_count,
      locCountry: r.loc_country, locNeighbourhood: r.loc_neighbourhood,
      locCity: r.loc_city, outreachStatus: r.outreach_status,
      valid_email: best !== null && validateEmail(best),
      email_validity: resolveValidity(best, validityMap),
      first_email: best,   // slice 0025: selected best-reachable address
      latitude: r.latitude, longitude: r.longitude,
      instagram: r.instagram, facebook: r.facebook, twitter: r.twitter,
      tiktok: r.tiktok, linkedin: r.linkedin, youtube: r.youtube,
      has_draft: r.has_draft === 1,
      outreachAnalysisJson: r.outreach_analysis_json,
      last_sent_at: r.last_sent_at, send_count: r.send_count,
      tracked: (r.tracked_count ?? 0) > 0,
      open_count: r.open_count, last_opened_at: r.last_opened_at,
      reply_type: r.reply_type,
    };
  });

  return { rows, total };
}

export interface RepliedLead extends FollowUpLead {
  replied_at: string | null;
}

// All replied leads, including auto-replies (slice 0014) — autos render muted and
// the operator can reclassify. Auto-replies still owe a follow-up via getFollowUpLeads.
// LEFT JOIN on email_sends: manually marked "Respondió" rows may predate send
// tracking and must still appear.
export function getRepliedLeads(page = 1, pageSize = 25): { rows: RepliedLead[]; total: number } {
  const offset = (page - 1) * pageSize;

  const lastSendJoin = `
    LEFT JOIN (
      SELECT business_id, MAX(sent_at) AS last_sent_at, COUNT(*) AS send_count,
             SUM(CASE WHEN tracking_token IS NOT NULL THEN 1 ELSE 0 END) AS tracked_count
      FROM email_sends WHERE status = 'sent' GROUP BY business_id
    ) ls ON ls.business_id = b.id
  `;
  // Slice 0014: autos are visible here too (muted in UI, operator can reclassify).
  // The response *rate* stays honest — it's a separate query (analytics.replied()).
  const whereClause = `
    WHERE b.outreach_status = 'replied'
  `;

  const leadsSQL = `
    SELECT b.id, b.name, b.address, b.phone, b.website, b.emails_json, b.category, b.rating, b.review_count,
           b.loc_country, b.loc_neighbourhood, b.loc_city, b.outreach_status, b.outreach_analysis_json,
           b.latitude, b.longitude, b.instagram, b.facebook, b.twitter, b.tiktok, b.linkedin, b.youtube,
           CASE WHEN d.business_id IS NOT NULL THEN 1 ELSE 0 END AS has_draft,
           b.reply_type, b.replied_at, ls.last_sent_at, ls.send_count, ls.tracked_count,
           COALESCE(op.open_count, 0) AS open_count, op.last_opened_at
    FROM businesses b
    ${lastSendJoin}
    LEFT JOIN (
      SELECT business_id, COUNT(DISTINCT send_id) AS open_count, MAX(opened_at) AS last_opened_at
      FROM email_opens GROUP BY business_id
    ) op ON op.business_id = b.id
    LEFT JOIN outreach_drafts d ON d.business_id = b.id
    ${whereClause}
    ORDER BY b.replied_at DESC
    LIMIT ? OFFSET ?
  `;
  const countSQL = `SELECT COUNT(*) AS n FROM businesses b ${whereClause}`;

  const raw = sqlite.prepare<(string | number)[], RawFollowUpRow & { replied_at: string | null }>(leadsSQL).all(pageSize, offset);
  const total = sqlite.prepare<[], { n: number }>(countSQL).get()?.n ?? 0;

  const validityMap = getEmailValidityMany(raw.flatMap(r => parseEmails(r.emails_json)));

  const rows: RepliedLead[] = raw.map(r => {
    const best = pickBestCachedEmail(parseEmails(r.emails_json), validityMap);
    return {
      id: r.id, name: r.name, address: r.address, phone: r.phone,
      website: r.website, emailsJson: r.emails_json, category: r.category,
      rating: r.rating, reviewCount: r.review_count,
      locCountry: r.loc_country, locNeighbourhood: r.loc_neighbourhood,
      locCity: r.loc_city, outreachStatus: r.outreach_status,
      valid_email: best !== null && validateEmail(best),
      email_validity: resolveValidity(best, validityMap),
      first_email: best,   // slice 0025: selected best-reachable address
      latitude: r.latitude, longitude: r.longitude,
      instagram: r.instagram, facebook: r.facebook, twitter: r.twitter,
      tiktok: r.tiktok, linkedin: r.linkedin, youtube: r.youtube,
      has_draft: r.has_draft === 1,
      outreachAnalysisJson: r.outreach_analysis_json,
      last_sent_at: r.last_sent_at, send_count: r.send_count,
      tracked: (r.tracked_count ?? 0) > 0,
      open_count: r.open_count, last_opened_at: r.last_opened_at,
      reply_type: r.reply_type, replied_at: r.replied_at,
    };
  });

  return { rows, total };
}

export function setFollowUpStatus(businessId: string, status: 'skip' | null): boolean {
  const result = sqlite.prepare(`UPDATE businesses SET follow_up_status = ? WHERE id = ?`)
    .run(status, businessId);
  return result.changes > 0;
}

export function getLatestSentEmail(businessId: string): { subject: string; body: string } | null {
  // id is AUTOINCREMENT — reliable "latest"; created_at has second-resolution ties
  return (sqlite.prepare(`
    SELECT subject, body FROM email_examples WHERE business_id = ? ORDER BY id DESC LIMIT 1
  `).get(businessId) as { subject: string; body: string } | undefined) ?? null;
}

export function getLastSentAt(businessId: string): string | null {
  return (sqlite.prepare(`
    SELECT MAX(sent_at) AS t FROM email_sends WHERE business_id = ? AND status = 'sent'
  `).get(businessId) as { t: string | null }).t;
}

export function hasOpens(businessId: string): boolean {
  return sqlite.prepare(`SELECT 1 FROM email_opens WHERE business_id = ? LIMIT 1`).get(businessId) !== undefined;
}

// ── Reply detection ───────────────────────────────────────────────────────────

export function getMeta(key: string): string | null {
  const row = sqlite.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  sqlite.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export type ReplyType = 'auto' | 'real' | 'unknown';

export interface ReplyCheckTarget {
  id: string;
  name: string;
  emails: string[];
  lastSentAt: string | null;
  // retro = already marked replied but never classified (pre-reply_type rows)
  retro: boolean;
}

export function getReplyCheckTargets(): ReplyCheckTarget[] {
  const rows = sqlite.prepare(`
    SELECT b.id, b.name, b.emails_json, b.outreach_status, ls.last_sent_at
    FROM businesses b
    LEFT JOIN (
      SELECT business_id, MAX(sent_at) AS last_sent_at
      FROM email_sends WHERE status = 'sent' GROUP BY business_id
    ) ls ON ls.business_id = b.id
    WHERE b.outreach_status = 'contacted'
       OR (b.outreach_status = 'replied' AND b.reply_type IS NULL)
  `).all() as { id: string; name: string; emails_json: string | null; outreach_status: string; last_sent_at: string | null }[];
  return rows
    .map(r => ({
      id: r.id,
      name: r.name,
      emails: parseEmails(r.emails_json).map(e => e.toLowerCase()),
      lastSentAt: r.last_sent_at,
      retro: r.outreach_status === 'replied',
    }))
    .filter(r => r.emails.length > 0);
}

// ── Bounce ingestion (slice 0013) ─────────────────────────────────────────────

// Flip the most recent 'sent' row for a business to 'bounced' (DSN-confirmed dead).
// 'bounced' is additive — getDailySendCount/history filter status='sent', so a
// bounced row stops counting as delivered. Returns false if no sent row exists.
export function markEmailSendBounced(businessId: string): boolean {
  const r = sqlite.prepare(`
    UPDATE email_sends SET status = 'bounced'
    WHERE id = (
      SELECT id FROM email_sends
      WHERE business_id = ? AND status = 'sent'
      ORDER BY sent_at DESC LIMIT 1
    )
  `).run(businessId);
  return r.changes > 0;
}

export function getBounceCount(): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE status = 'bounced'`).get() as { n: number }).n;
}

export function markReplied(businessId: string, replyType: ReplyType): boolean {
  // Only flips 'contacted' → 'replied': idempotent, respects manual transitions
  const result = sqlite.prepare(`
    UPDATE businesses SET outreach_status = 'replied', replied_at = ?, reply_type = ?
    WHERE id = ? AND outreach_status = 'contacted'
  `).run(nowUtcMinus3(), replyType, businessId);
  return result.changes > 0;
}

export function setReplyType(businessId: string, replyType: ReplyType): boolean {
  // Retro classification only — never touches status or replied_at, never overwrites
  const result = sqlite.prepare(`
    UPDATE businesses SET reply_type = ?
    WHERE id = ? AND outreach_status = 'replied' AND reply_type IS NULL
  `).run(replyType, businessId);
  return result.changes > 0;
}

export function reclassifyReply(businessId: string, replyType: ReplyType): boolean {
  // Operator reclassification (slice 0014) — overwrites the auto-guess in either
  // direction (auto↔real). Unlike setReplyType, no IS NULL guard. Status untouched.
  const result = sqlite.prepare(`
    UPDATE businesses SET reply_type = ?
    WHERE id = ? AND outreach_status = 'replied'
  `).run(replyType, businessId);
  return result.changes > 0;
}
