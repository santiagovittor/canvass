import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const scrapeJobs = sqliteTable('scrape_jobs', {
  id: text('id').primaryKey(),
  searchTerm: text('search_term').notNull(),
  language: text('language').notNull().default('es'),
  bboxJson: text('bbox_json').notNull(),
  gridCellKm: real('grid_cell_km').notNull(),
  cellCount: integer('cell_count').notNull(),
  status: text('status', { enum: ['pending', 'running', 'enriching', 'done', 'error'] }).notNull().default('pending'),
  businessesFound: integer('businesses_found').notNull().default(0),
  enrichmentProgress: integer('enrichment_progress').notNull().default(0),
  cellsDone: integer('cells_done').notNull().default(0),
  // Persisted for boot-time resume of interrupted jobs; NULL on legacy rows (not resumable)
  geometryJson: text('geometry_json'),
  extractEmails: integer('extract_emails').notNull().default(1),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const businesses = sqliteTable('businesses', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  name: text('name').notNull(),
  address: text('address'),
  phone: text('phone'),
  website: text('website'),
  hoursJson: text('hours_json'),
  rating: real('rating'),
  reviewCount: integer('review_count'),
  category: text('category'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  instagram: text('instagram'),
  facebook: text('facebook'),
  twitter: text('twitter'),
  tiktok: text('tiktok'),
  linkedin: text('linkedin'),
  youtube: text('youtube'),
  emailsJson: text('emails_json'),
  socialEnriched: integer('social_enriched').notNull().default(0),
  scrapedAt: text('scraped_at').notNull(),
  outreachStatus: text('outreach_status'),
  outreachNote: text('outreach_note'),
  locCountry: text('loc_country'),
  locState: text('loc_state'),
  locCity: text('loc_city'),
  locNeighbourhood: text('loc_neighbourhood'),
  locationEnriched: integer('location_enriched').notNull().default(0),
  followUpStatus: text('follow_up_status'),
  repliedAt: text('replied_at'),
  replyType: text('reply_type', { enum: ['auto', 'real', 'unknown'] }),
});

// Batch automation: one batch_run drives N batch_items through the prepare state
// machine. Counters are denormalized totals updated on every item transition so the
// SSE progress readout is a single cheap row read. Resumable across restart.
export const batchRuns = sqliteTable('batch_runs', {
  id: text('id').primaryKey(),
  status: text('status', { enum: ['running', 'paused', 'done', 'canceled'] }).notNull().default('running'),
  size: integer('size').notNull(),
  dryRun: integer('dry_run').notNull().default(0),
  pauseReason: text('pause_reason'),
  total: integer('total').notNull().default(0),
  processed: integer('processed').notNull().default(0),
  skippedNoEvidence: integer('skipped_no_evidence').notNull().default(0),
  heldGeneric: integer('held_generic').notNull().default(0),
  queuedForSend: integer('queued_for_send').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// state machine per item. Terminal: skipped_no_evidence | held_generic | failed |
// queued_for_send. Every transition is persisted so a restart resumes in-flight items.
export const batchItems = sqliteTable('batch_items', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull(),
  businessId: text('business_id').notNull(),
  state: text('state', {
    enum: [
      'pending', 'analyzing', 'analyzed', 'composing', 'composed', 'verifying', 'verified',
      'queued_for_send', 'skipped_no_evidence', 'held_generic', 'failed',
    ],
  }).notNull().default('pending'),
  disposition: text('disposition'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Persisted daily Gemini request budget, keyed to the Pacific calendar date so it
// matches Google's midnight-Pacific RPD reset and survives process restarts.
export const geminiRpd = sqliteTable('gemini_rpd', {
  pacificDate: text('pacific_date').primaryKey(),
  count: integer('count').notNull().default(0),
});

export const premiumAnalyses = sqliteTable('premium_analyses', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull(),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
  renderOutcome: text('render_outcome'),
  finalUrl: text('final_url'),
  signalsJson: text('signals_json'),
  cookieWall: integer('cookie_wall').notNull().default(0),
  consoleErrorsJson: text('console_errors_json'),
  desktopScreenshotPath: text('desktop_screenshot_path'),
  mobileScreenshotPath: text('mobile_screenshot_path'),
  htmlPath: text('html_path'),
  networkLogPath: text('network_log_path'),
  detectedSigsJson: text('detected_sigs_json'),
  psiJson: text('psi_json'),
  visionJson: text('vision_json'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});
