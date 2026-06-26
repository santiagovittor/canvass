import { randomBytes } from 'crypto';
import { eq, or, sql } from 'drizzle-orm';
import { db, getAnalyzableBusinessIdsForJob } from '../db';
import { countNewBusinessesForJob, upsertScrapedAreaFromJob } from '../db/geo';
import { scrapeJobs, businesses } from '../db/schema';
import { broadcast } from '../sse';
import { bboxFromGeoJSON, cellCount as computeCellCount, computeGrid } from './grid';
import * as gosom from './gosom';
import { kickEnrichment } from './enrichmentQueue';
import { autoEnqueueForAnalysis } from './autoAnalyzeEnqueue';

const cancellers = new Map<string, AbortController>();

export const B2B_CATEGORIES = [
  'restaurante', 'bar', 'hotel', 'gimnasio',
  'peluqueria', 'salon de belleza', 'spa',
  'clinica', 'dentista', 'veterinaria',
  'farmacia', 'optica',
  'ferreteria', 'materiales de construccion',
  'inmobiliaria', 'estudio contable', 'abogado',
  'concesionario', 'mecanico', 'taller',
  'supermercado', 'tienda de ropa', 'zapateria',
  'electronica', 'muebleria', 'floristeria',
];

function pointInPolygon(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export interface StartJobParams {
  geometry: { type: string; coordinates: number[][][] };
  searchTerm: string;
  language: string;
  gridCellKm: number;
  extractEmails: boolean;
  // City-tiling provenance (slice 0038): set by the /city route so the terminal
  // block can write the scraped_areas coverage registry. Omitted for polygon jobs.
  runKind?: string;
  cityArea?: string;
}

export async function startJob(params: StartJobParams): Promise<string> {
  const jobId = randomBytes(16).toString('base64url');
  const bbox = bboxFromGeoJSON(params.geometry);
  const count = computeCellCount(bbox, params.gridCellKm);
  const now = new Date().toISOString();

  // Zero-cell guard runs here (synchronously) so the route can 400 instead of
  // returning a jobId that immediately errors. runJob recomputes the same grid.
  const ring = params.geometry.coordinates[0];
  const usableCells = computeGrid(bbox, params.gridCellKm).filter(cell =>
    pointInPolygon((cell.minLon + cell.maxLon) / 2, (cell.minLat + cell.maxLat) / 2, ring));
  if (usableCells.length === 0) throw new Error('Polygon too small for current cell size — try reducing cell size or drawing a larger area.');

  db.insert(scrapeJobs).values({
    id: jobId,
    searchTerm: params.searchTerm,
    language: params.language,
    bboxJson: JSON.stringify(bbox),
    gridCellKm: params.gridCellKm,
    cellCount: count,
    status: 'pending',
    geometryJson: JSON.stringify(params.geometry),
    extractEmails: params.extractEmails ? 1 : 0,
    runKind: params.runKind ?? null,
    cityArea: params.cityArea ?? null,
    createdAt: now,
  }).run();

  runJob(jobId, params, bbox, count).catch(err => {
    console.error(`Job ${jobId} unhandled error:`, err);
  });

  return jobId;
}

// Synchronous variant for the scrape scheduler: creates a scrapeJob row, awaits
// runJob directly (does not fire-and-forget), returns businessesFound from DB.
export async function runJobSync(params: StartJobParams): Promise<{ jobId: string; businessesFound: number }> {
  const jobId = randomBytes(16).toString('base64url');
  const bbox = bboxFromGeoJSON(params.geometry);
  const count = computeCellCount(bbox, params.gridCellKm);
  const now = new Date().toISOString();
  const ring = params.geometry.coordinates[0];
  const usableCells = computeGrid(bbox, params.gridCellKm).filter(cell =>
    pointInPolygon((cell.minLon + cell.maxLon) / 2, (cell.minLat + cell.maxLat) / 2, ring));
  if (usableCells.length === 0) throw new Error('Polygon too small for current cell size');
  db.insert(scrapeJobs).values({
    id: jobId,
    searchTerm: params.searchTerm,
    language: params.language,
    bboxJson: JSON.stringify(bbox),
    gridCellKm: params.gridCellKm,
    cellCount: count,
    status: 'pending',
    geometryJson: JSON.stringify(params.geometry),
    extractEmails: params.extractEmails ? 1 : 0,
    createdAt: now,
  }).run();
  await runJob(jobId, params, bbox, count);
  const job = db.select().from(scrapeJobs).where(eq(scrapeJobs.id, jobId)).get();
  return { jobId, businessesFound: job?.businessesFound ?? 0 };
}

export interface KeywordJobParams {
  query: string;
  lang: string;
  depth?: number;
  geoBias?: { lat: string; lon: string; radius: number };
  // Client-generated correlation id (slice 0003). The route is synchronous so
  // the client has no jobId until the run finishes; it mints a runId, sends it
  // in the POST body, and matches the keyword:* stage events back to its run.
  // Optional: the scrape scheduler calls this with no client listening.
  runId?: string;
}

export async function runKeywordJobSync(
  params: KeywordJobParams,
): Promise<{ added: number; deduped: number; businessIds: string[] }> {
  const jobId = randomBytes(16).toString('base64url');
  const runId = params.runId ?? randomBytes(8).toString('base64url');
  const ac = new AbortController();
  const query = params.query.trim();
  broadcast('keyword:started', { runId, query });
  try {

  // Minimal scrape_jobs row so the enrichmentQueue left-join (enrichmentQueue.ts)
  // resolves extractEmails=1 and emails get scraped for website-bearing keyword
  // leads — exactly like polygon leads (slice 0004). status='running' + run_kind
  // ='keyword' makes this a durable, rehydratable run (slice 0012): the active-runs
  // read-model surfaces it and the polygon snapshot / resumeOrphanedJobs exclude it
  // by run_kind. Keyword runs are synchronous and have no bbox/geometry, so those
  // columns are benign placeholders / null.
  db.insert(scrapeJobs).values({
    id: jobId,
    searchTerm: params.query.trim(),
    language: params.lang,
    bboxJson: '[]',
    gridCellKm: 0,
    cellCount: 0,
    status: 'running',
    runKind: 'keyword',
    keywordRunId: runId,
    keywordStage: 'submitting',
    geometryJson: null,
    extractEmails: 1,
    createdAt: new Date().toISOString(),
  }).run();

  // Persist the live keyword stage so a rehydrated client (slice 0012) resumes the
  // tracker at the right step. Rides alongside the existing keyword:stage broadcasts.
  const persistStage = (stage: 'scraping' | 'saving' | 'enriching') =>
    db.update(scrapeJobs).set({ keywordStage: stage }).where(eq(scrapeJobs.id, jobId)).run();

  const gosomId = await createGosomJobWithRetry({
    jobId,
    keywords: [params.query.trim()],
    lang: params.lang,
    latitude: params.geoBias ? parseFloat(params.geoBias.lat) : undefined,
    longitude: params.geoBias ? parseFloat(params.geoBias.lon) : undefined,
    radiusMeters: params.geoBias?.radius,
    email: false,
    depth: params.depth,
  }, ac.signal);
  console.log(`[jobRunner] broadcast keyword:stage scraping run=${runId}`);
  persistStage('scraping');
  broadcast('keyword:stage', { runId, stage: 'scraping' });

  const polledResults = await pollUntilDone(gosomId, ac.signal, KEYWORD_WEDGE_PROBE_AFTER_MS);
  const rawResults = polledResults ?? await gosom.downloadResults(gosomId);

  const scrapedAt = new Date().toISOString();
  console.log(`[jobRunner] broadcast keyword:stage saving run=${runId}`);
  persistStage('saving');
  broadcast('keyword:stage', { runId, stage: 'saving' });
  // upsertRawResults handles lat/lng guard internally — no polygon filter needed
  const { inserted } = upsertRawResults(rawResults as Record<string, unknown>[], jobId, scrapedAt);

  // job_id is written on INSERT only (not on conflict-update) so this query
  // accurately counts genuinely new rows from this run.
  const addedRows = db.select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.jobId, jobId))
    .all();
  const added = addedRows.length;
  const businessIds = addedRows.map(r => r.id);
  const deduped = Math.max(0, inserted - added);

  kickEnrichment();
  console.log(`[jobRunner] broadcast keyword:stage enriching run=${runId}`);
  persistStage('enriching');
  broadcast('keyword:stage', { runId, stage: 'enriching' });
  // Auto-analyze: enqueue this run's website-bearing leads (Q7 filter at db layer,
  // consistent with the polygon path). Covers both the keyword scheduler branch
  // and POST /api/keyword-scrape/instant — no route change needed.
  const analyzable = getAnalyzableBusinessIdsForJob(jobId);
  const { enqueued, skipped } = autoEnqueueForAnalysis(analyzable);
  console.log(`[jobRunner] auto-analyze keyword job=${jobId} enqueued=${enqueued} skipped=${skipped}`);
  // Terminal: the durable keyword run is complete — flip the row out of 'running'
  // so the active-runs read-model stops surfacing it.
  db.update(scrapeJobs)
    .set({ status: 'done', keywordStage: 'done', completedAt: new Date().toISOString() })
    .where(eq(scrapeJobs.id, jobId)).run();
  broadcast('keyword:done', { runId, added, deduped });
  return { added, deduped, businessIds };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    db.update(scrapeJobs)
      .set({ status: 'error', keywordStage: 'error', errorMessage: message })
      .where(eq(scrapeJobs.id, jobId)).run();
    broadcast('keyword:error', { runId, message });
    throw err;
  }
}

// On boot, re-enter jobs interrupted by a server restart instead of failing them.
// computeGrid order is deterministic, so cellsDone identifies the first unfinished
// cell; the in-flight cell is redone and the place_id upsert makes that idempotent.
export function resumeOrphanedJobs(): void {
  const orphans = db.select().from(scrapeJobs)
    .where(or(eq(scrapeJobs.status, 'running'), eq(scrapeJobs.status, 'enriching')))
    .all();
  for (const job of orphans) {
    if (job.runKind === 'keyword') {
      // A keyword run is synchronous — it cannot be resumed after a restart.
      // Mark the interrupted row error so it leaves the active-runs read-model.
      db.update(scrapeJobs).set({ status: 'error', keywordStage: 'error', errorMessage: 'Server restarted' }).where(eq(scrapeJobs.id, job.id)).run();
    } else if (job.status === 'enriching') {
      // Legacy status from before enrichment was decoupled: scraping had
      // finished, so the job is done; the enrichment queue picks up the rest.
      db.update(scrapeJobs).set({ status: 'done', completedAt: new Date().toISOString() }).where(eq(scrapeJobs.id, job.id)).run();
    } else if (!resumeJob(job)) {
      // Legacy row from before geometry was persisted — not resumable
      db.update(scrapeJobs).set({ status: 'error', errorMessage: 'Server restarted' }).where(eq(scrapeJobs.id, job.id)).run();
    }
  }
}

function resumeJob(job: typeof scrapeJobs.$inferSelect): boolean {
  if (!job.geometryJson) return false;
  const params: StartJobParams = {
    geometry: JSON.parse(job.geometryJson),
    searchTerm: job.searchTerm,
    language: job.language,
    gridCellKm: job.gridCellKm,
    extractEmails: job.extractEmails === 1,
  };
  const bbox = JSON.parse(job.bboxJson) as ReturnType<typeof bboxFromGeoJSON>;
  console.log(`[jobRunner] resuming job ${job.id} from cell ${job.cellsDone}/${job.cellCount}`);
  runJob(job.id, params, bbox, job.cellCount, { startCell: job.cellsDone, businessesFound: job.businessesFound })
    .catch(err => console.error(`Job ${job.id} unhandled error:`, err));
  return true;
}

// User-triggered resume of a job that errored mid-grid (gosom died, cancel, etc.).
export function resumeErroredJob(jobId: string): 'ok' | 'not_found' | 'not_resumable' {
  const job = db.select().from(scrapeJobs).where(eq(scrapeJobs.id, jobId)).get();
  if (!job) return 'not_found';
  if (job.status !== 'error' || !job.geometryJson || cancellers.has(jobId)) return 'not_resumable';
  db.update(scrapeJobs).set({ status: 'running', errorMessage: null }).where(eq(scrapeJobs.id, jobId)).run();
  return resumeJob(job) ? 'ok' : 'not_resumable';
}

function upsertRawResults(
  rawResults: Record<string, unknown>[],
  jobId: string,
  scrapedAt: string,
): { inserted: number } {
  let inserted = 0;
  for (const r of rawResults) {
    const lat = (r.latitude as number) ?? (r.lat as number);
    const lng = (r.longitude as number) ?? (r.lng as number);
    if (lat == null || lng == null) continue;

    db.insert(businesses).values({
      id: (r.place_id as string) ?? randomBytes(16).toString('base64url'),
      jobId,
      name: (r.title as string) ?? 'Unknown',
      address: (r.address as string) ?? null,
      phone: (r.phone as string) ?? null,
      website: (r.website as string) ?? null,
      hoursJson: r.open_hours ? JSON.stringify(r.open_hours) : null,
      rating: (r.review_rating as number) ?? null,
      reviewCount: (r.review_count as number) ?? (r.reviewCount as number) ?? null,
      category: (r.category as string) ?? null,
      latitude: lat,
      longitude: lng,
      instagram: null, facebook: null, twitter: null, tiktok: null,
      linkedin: null, youtube: null,
      emailsJson: r.emails ? JSON.stringify(r.emails) : null,
      socialEnriched: 0,
      scrapedAt,
    }).onConflictDoUpdate({
      target: businesses.id,
      set: {
        name: sql`excluded.name`,
        address: sql`excluded.address`,
        phone: sql`excluded.phone`,
        website: sql`excluded.website`,
        hoursJson: sql`excluded.hours_json`,
        rating: sql`excluded.rating`,
        reviewCount: sql`excluded.review_count`,
        category: sql`excluded.category`,
        latitude: sql`excluded.latitude`,
        longitude: sql`excluded.longitude`,
        instagram: sql`excluded.instagram`,
        facebook: sql`excluded.facebook`,
        twitter: sql`excluded.twitter`,
        tiktok: sql`excluded.tiktok`,
        linkedin: sql`excluded.linkedin`,
        youtube: sql`excluded.youtube`,
        emailsJson: sql`COALESCE(excluded.emails_json, emails_json)`,
        socialEnriched: sql`excluded.social_enriched`,
        scrapedAt: sql`excluded.scraped_at`,
      },
    }).run();
    inserted++;
  }
  return { inserted };
}

async function runJob(
  jobId: string,
  params: StartJobParams,
  bbox: ReturnType<typeof bboxFromGeoJSON>,
  count: number,
  resume?: { startCell: number; businessesFound: number },
): Promise<void> {
  const ac = new AbortController();
  cancellers.set(jobId, ac);

  // Hoisted so the catch block can include progress in the job:error payload
  let cellsDone = resume?.startCell ?? 0;
  let businessesFound = resume?.businessesFound ?? 0;
  let totalCells = count;

  try {
    const categories = params.searchTerm.trim() ? [params.searchTerm.trim()] : B2B_CATEGORIES;
    const polygonRing = params.geometry.coordinates[0];
    const cells = computeGrid(bbox, params.gridCellKm).filter(cell => {
      const centerLat = (cell.minLat + cell.maxLat) / 2;
      const centerLng = (cell.minLon + cell.maxLon) / 2;
      return pointInPolygon(centerLng, centerLat, polygonRing);
    });
    if (cells.length === 0) throw new Error('Polygon too small for current cell size — try reducing cell size or drawing a larger area.');
    const radiusMeters = (params.gridCellKm * 1000) / 2;
    totalCells = cells.length;
    const totalJobs = cells.length * categories.length;
    const seenIds = new Set<string>();
    const startCell = Math.min(resume?.startCell ?? 0, cells.length);
    cellsDone = startCell;
    let jobsDone = startCell * categories.length;

    db.update(scrapeJobs).set({ status: 'running', cellCount: totalCells }).where(eq(scrapeJobs.id, jobId)).run();
    broadcast('job:started', { jobId, cellCount: totalCells, totalJobs });

    for (let i = startCell; i < cells.length; i++) {
      if (ac.signal.aborted) return;
      const cell = cells[i];
      const centerLat = (cell.minLat + cell.maxLat) / 2;
      const centerLng = (cell.minLon + cell.maxLon) / 2;

      for (const category of categories) {
        if (ac.signal.aborted) return;

        const gosomId = await createGosomJobWithRetry({
          jobId,
          keywords: [category],
          lang: params.language,
          latitude: centerLat,
          longitude: centerLng,
          radiusMeters,
          // Email extraction is done Node-side in socialEnricher — gosom's Playwright
          // email jobs stall the worker pool and trip exit-on-inactivity mid-grid.
          email: false,
        }, ac.signal);

        const polledResults = await pollUntilDone(gosomId, ac.signal);
        if (ac.signal.aborted) return;

        const rawResults = polledResults ?? await gosom.downloadResults(gosomId);
        const scrapedAt = new Date().toISOString();

        let countNoLatLng = 0, countOutsidePolygon = 0, countDuplicate = 0;
        const toUpsert: Record<string, unknown>[] = [];
        for (const r of rawResults) {
          const pid = r.place_id as string | undefined;
          if (pid && seenIds.has(pid)) { countDuplicate++; continue; }
          const lat = (r.latitude as number) ?? (r.lat as number);
          const lng = (r.longitude as number) ?? (r.lng as number);
          if (lat == null || lng == null) { countNoLatLng++; continue; }
          if (!pointInPolygon(lng, lat, polygonRing)) { countOutsidePolygon++; continue; }
          if (pid) seenIds.add(pid);
          toUpsert.push(r);
        }
        const { inserted: countInserted } = upsertRawResults(toUpsert, jobId, scrapedAt);
        businessesFound += countInserted;
        console.log(`[jobRunner] pipeline stats for ${gosomId}: inserted=${countInserted} noLatLng=${countNoLatLng} outsidePolygon=${countOutsidePolygon} duplicate=${countDuplicate}`);

        jobsDone++;
        broadcast('job:progress', { jobId, cellsDone, totalCells, jobsDone, jobsTotal: totalJobs, category, newBusinesses: countInserted, totalBusinesses: businessesFound });
      }

      broadcast('businesses_updated', { jobId, count: businessesFound });
      cellsDone++;
      db.update(scrapeJobs).set({ cellsDone, businessesFound }).where(eq(scrapeJobs.id, jobId)).run();
      // Enrichment is decoupled from job status: the background queue works
      // through this cell's businesses while scraping continues.
      kickEnrichment();
    }

    console.log('[jobRunner] total businesses found:', businessesFound, 'for job', jobId);
    broadcast('job:scraped', { jobId, count: businessesFound });

    const completedAt = new Date().toISOString();
    db.update(scrapeJobs)
      .set({ status: 'done', completedAt, businessesFound })
      .where(eq(scrapeJobs.id, jobId))
      .run();

    // Coverage registry (slice 0038): record city-tiling runs only. added = rows
    // genuinely new to this job (jobId-bearing); deduped = re-seen this run.
    if (params.runKind === 'city' && params.cityArea) {
      const added = countNewBusinessesForJob(jobId);
      upsertScrapedAreaFromJob({
        displayName: params.cityArea,
        bboxJson: JSON.stringify(bbox),
        keyword: params.searchTerm || null,
        language: params.language,
        added,
        deduped: Math.max(0, businessesFound - added),
        jobId,
        completedAt,
      });
    }

    broadcast('job:done', { jobId });
    kickEnrichment();
  } catch (err) {
    if (ac.signal.aborted) return;
    const message = err instanceof Error ? err.message : 'Unknown error';
    db.update(scrapeJobs).set({ status: 'error', errorMessage: message }).where(eq(scrapeJobs.id, jobId)).run();
    broadcast('job:error', { jobId, message, cellsDone, cellCount: totalCells, businessesFound });
  } finally {
    cancellers.delete(jobId);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(t); reject(new Error('Aborted')); };
    // Detach on normal resolve — leaving listeners attached leaks one per poll iteration
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_MS = 17 * 60 * 1000; // gosom max_time (15 min) + grace
const WEDGE_PROBE_AFTER_MS = 3 * 60 * 1000; // polygon: per-cell scrapes can run long, stay conservative
// Keyword runs are a single ~90s batch; gosom often wedges with the scrape done
// but status stuck on "working" (upstream #143). Probe for stable results right
// after the typical finish so recovery is ~3min, not ~4.6min, and the worker's
// single-run lock frees sooner. The 2×WEDGE_PROBE_EVERY_MS stability guard still
// prevents cutting a scrape that's genuinely still producing rows.
const KEYWORD_WEDGE_PROBE_AFTER_MS = 90 * 1000;
const WEDGE_PROBE_EVERY_MS = 45 * 1000;
const PENDING_RESTART_AFTER_MS = 2 * 60 * 1000; // healthy runner picks pending jobs in seconds

// gosom's web runner randomly dies after finishing a batch (upstream issue
// gosom/google-maps-scraper#143): the CSV is fully written ("scrapemate
// exited") but the job status never flips from "working" and the queue
// freezes. Two recovery paths:
//   - status stuck "working": probe the download endpoint — if the row count
//     stops growing the batch is final; return its rows and restart gosom so
//     the next cell starts against a healthy runner.
//   - status stuck "pending": the runner died before picking the job; restart
//     gosom (re-picks pending jobs on boot) and keep polling.
// Returns null when the status flipped normally (caller downloads as usual).
async function pollUntilDone(
  gosomId: string,
  signal: AbortSignal,
  wedgeProbeAfterMs: number = WEDGE_PROBE_AFTER_MS,
): Promise<Record<string, unknown>[] | null> {
  let seenWorking = false;
  let lastProbeAt = 0;
  let lastRowCount = -1;
  let stableProbes = 0;
  let pendingSince: number | null = null;
  let restartsUsed = 0;
  const startedAt = Date.now();

  while (Date.now() - startedAt < MAX_POLL_MS) {
    if (signal.aborted) return null;
    try {
      const status = await gosom.getJob(gosomId);
      const s = status.Status?.toLowerCase() ?? '';
      if (s === 'error' || s === 'failed') throw new Error('Gosom job failed');
      if (s === 'working' || s === 'running') seenWorking = true;
      if (seenWorking && (s === 'ok' || s === 'completed' || s === 'done' || s === 'finished' || s === 'success')) return null;
      if (s === 'pending') {
        pendingSince ??= Date.now();
      } else {
        pendingSince = null;
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'Gosom job failed') throw err;
      // transient — gosom may be restarting; keep polling
    }

    const now = Date.now();

    if (pendingSince !== null && now - pendingSince > PENDING_RESTART_AFTER_MS && restartsUsed < 2) {
      restartsUsed++;
      pendingSince = null;
      console.warn(`[jobRunner] gosom job ${gosomId} stuck pending — runner likely wedged, restarting gosom (attempt ${restartsUsed})`);
      await gosom.restartContainer();
    }

    if (seenWorking && now - startedAt > wedgeProbeAfterMs && now - lastProbeAt >= WEDGE_PROBE_EVERY_MS) {
      lastProbeAt = now;
      try {
        const rows = await gosom.downloadResults(gosomId);
        if (rows.length === lastRowCount) {
          stableProbes++;
          if (stableProbes >= 2) {
            console.warn(`[jobRunner] gosom job ${gosomId} status stalled but results are stable (${rows.length} rows) — treating as complete`);
            await gosom.restartContainer(); // heal the runner before the next cell
            return rows;
          }
        } else {
          stableProbes = 0;
          lastRowCount = rows.length;
        }
      } catch { /* no results yet */ }
    }

    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
  throw new Error('Gosom job stalled — no status update and no stable results within 17 minutes');
}

async function createGosomJobWithRetry(params: gosom.GosomJobParams, signal: AbortSignal): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gosom.createJob(params);
    } catch (err) {
      if (attempt >= 3 || signal.aborted) throw err;
      console.warn(`[jobRunner] gosom createJob failed (attempt ${attempt}), retrying in 10s:`, err instanceof Error ? err.message : err);
      await abortableDelay(10_000, signal);
    }
  }
}

export function cancelJob(jobId: string): boolean {
  const ac = cancellers.get(jobId);
  if (ac) {
    ac.abort();
    cancellers.delete(jobId);
  } else {
    // No in-memory runner — check for orphaned job (server restarted mid-run)
    const job = db.select({ status: scrapeJobs.status })
      .from(scrapeJobs)
      .where(eq(scrapeJobs.id, jobId))
      .get();
    if (!job || (job.status !== 'running' && job.status !== 'enriching')) return false;
  }
  db.update(scrapeJobs)
    .set({ status: 'error', errorMessage: 'Cancelled by user' })
    .where(eq(scrapeJobs.id, jobId))
    .run();
  broadcast('job:error', { jobId, message: 'Cancelled by user' });
  return true;
}
