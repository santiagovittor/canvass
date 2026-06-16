import { sqlite } from './index';

export function runMigrations() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id TEXT PRIMARY KEY,
      search_term TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'es',
      bbox_json TEXT NOT NULL,
      grid_cell_km REAL NOT NULL,
      cell_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      businesses_found INTEGER NOT NULL DEFAULT 0,
      enrichment_progress INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      hours_json TEXT,
      rating REAL,
      review_count INTEGER,
      category TEXT,
      latitude REAL,
      longitude REAL,
      instagram TEXT,
      facebook TEXT,
      twitter TEXT,
      tiktok TEXT,
      linkedin TEXT,
      youtube TEXT,
      emails_json TEXT,
      social_enriched INTEGER NOT NULL DEFAULT 0,
      scraped_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS businesses_job_id_idx ON businesses(job_id);
  `);

  const jobCols = (sqlite.prepare('PRAGMA table_info(scrape_jobs)').all() as { name: string }[]).map(r => r.name);
  if (!jobCols.includes('cells_done')) {
    sqlite.exec('ALTER TABLE scrape_jobs ADD COLUMN cells_done INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('geometry_json')) {
    sqlite.exec('ALTER TABLE scrape_jobs ADD COLUMN geometry_json TEXT');
  }
  if (!jobCols.includes('extract_emails')) {
    sqlite.exec('ALTER TABLE scrape_jobs ADD COLUMN extract_emails INTEGER NOT NULL DEFAULT 1');
  }

  const cols = (sqlite.prepare('PRAGMA table_info(businesses)').all() as { name: string }[]).map(r => r.name);
  if (!cols.includes('outreach_status')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN outreach_status TEXT');
  }
  if (!cols.includes('outreach_note')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN outreach_note TEXT');
  }
  if (!cols.includes('outreach_analysis_json')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN outreach_analysis_json TEXT');
  }
  if (!cols.includes('loc_country')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN loc_country TEXT');
  }
  if (!cols.includes('loc_state')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN loc_state TEXT');
  }
  if (!cols.includes('loc_city')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN loc_city TEXT');
  }
  if (!cols.includes('loc_neighbourhood')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN loc_neighbourhood TEXT');
  }
  if (!cols.includes('location_enriched')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN location_enriched INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('follow_up_status')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN follow_up_status TEXT');
  }
  if (!cols.includes('replied_at')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN replied_at TEXT');
  }
  if (!cols.includes('reply_type')) {
    sqlite.exec('ALTER TABLE businesses ADD COLUMN reply_type TEXT');
  }

  // Premium website analysis: one row per run; evidence bundle lives on disk
  // under data/premium/<businessId>/<runId>/, paths stored relative to data dir.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS premium_analyses (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      render_outcome TEXT,
      final_url TEXT,
      signals_json TEXT,
      cookie_wall INTEGER NOT NULL DEFAULT 0,
      console_errors_json TEXT,
      desktop_screenshot_path TEXT,
      mobile_screenshot_path TEXT,
      html_path TEXT,
      network_log_path TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS premium_analyses_business_id_idx ON premium_analyses(business_id);
  `);

  const premiumCols = (sqlite.prepare('PRAGMA table_info(premium_analyses)').all() as { name: string }[]).map(r => r.name);
  if (!premiumCols.includes('detected_sigs_json')) {
    sqlite.exec('ALTER TABLE premium_analyses ADD COLUMN detected_sigs_json TEXT');
  }
}
