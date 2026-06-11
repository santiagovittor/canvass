import { randomBytes } from 'crypto';
import { eq, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { scrapeJobs, businesses } from '../db/schema';
import { broadcast } from '../sse';
import { bboxFromGeoJSON, cellCount as computeCellCount, computeGrid } from './grid';
import * as gosom from './gosom';
import { enrichJob } from './socialEnricher';
import { enrichLocationJob } from './locationEnricher';

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
    createdAt: now,
  }).run();

  runJob(jobId, params, bbox, count).catch(err => {
    console.error(`Job ${jobId} unhandled error:`, err);
  });

  return jobId;
}

// On boot, re-enter jobs interrupted by a server restart instead of failing them.
// computeGrid order is deterministic, so cellsDone identifies the first unfinished
// cell; the in-flight cell is redone and the place_id upsert makes that idempotent.
export function resumeOrphanedJobs(): void {
  const orphans = db.select().from(scrapeJobs)
    .where(or(eq(scrapeJobs.status, 'running'), eq(scrapeJobs.status, 'enriching')))
    .all();
  for (const job of orphans) {
    if (!job.geometryJson) {
      // Legacy row from before geometry was persisted — not resumable
      db.update(scrapeJobs).set({ status: 'error', errorMessage: 'Server restarted' }).where(eq(scrapeJobs.id, job.id)).run();
      continue;
    }
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
  }
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
    const totalCells = cells.length;
    const totalJobs = cells.length * categories.length;
    const seenIds = new Set<string>();
    const startCell = Math.min(resume?.startCell ?? 0, cells.length);
    let cellsDone = startCell;
    let jobsDone = startCell * categories.length;
    let businessesFound = resume?.businessesFound ?? 0;

    db.update(scrapeJobs).set({ status: 'running', cellCount: totalCells }).where(eq(scrapeJobs.id, jobId)).run();
    broadcast('job:started', { jobId, cellCount: totalCells, totalJobs });

    for (let i = startCell; i < cells.length; i++) {
      if (ac.signal.aborted) return;
      const cell = cells[i];
      const centerLat = (cell.minLat + cell.maxLat) / 2;
      const centerLng = (cell.minLon + cell.maxLon) / 2;

      for (const category of categories) {
        if (ac.signal.aborted) return;

        const gosomId = await gosom.createJob({
          jobId,
          keywords: [category],
          lang: params.language,
          latitude: centerLat,
          longitude: centerLng,
          radiusMeters,
          email: params.extractEmails,
        });

        await pollUntilDone(gosomId, ac.signal);
        if (ac.signal.aborted) return;

        const rawResults = await gosom.downloadResults(gosomId);
        const scrapedAt = new Date().toISOString();

        let countNoLatLng = 0, countOutsidePolygon = 0, countDuplicate = 0, countInserted = 0;
        for (const r of rawResults) {
          const pid = r.place_id as string | undefined;
          if (pid && seenIds.has(pid)) { countDuplicate++; continue; }

          const lat = (r.latitude as number) ?? (r.lat as number);
          const lng = (r.longitude as number) ?? (r.lng as number);
          if (lat == null || lng == null) { countNoLatLng++; continue; }

          if (!pointInPolygon(lng, lat, polygonRing)) { countOutsidePolygon++; continue; }

          if (pid) seenIds.add(pid);
          countInserted++;

          db.insert(businesses).values({
            id: pid ?? randomBytes(16).toString('base64url'),
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
              emailsJson: sql`excluded.emails_json`,
              socialEnriched: sql`excluded.social_enriched`,
              scrapedAt: sql`excluded.scraped_at`,
            },
          }).run();

          businessesFound++;
        }
        console.log(`[jobRunner] pipeline stats for ${gosomId}: inserted=${countInserted} noLatLng=${countNoLatLng} outsidePolygon=${countOutsidePolygon} duplicate=${countDuplicate}`);

        jobsDone++;
        broadcast('job:progress', { jobId, cellsDone, totalCells, jobsDone, jobsTotal: totalJobs, newBusinesses: countInserted, totalBusinesses: businessesFound });
      }

      broadcast('businesses_updated', { jobId, count: businessesFound });
      cellsDone++;
      db.update(scrapeJobs).set({ cellsDone }).where(eq(scrapeJobs.id, jobId)).run();
    }

    console.log('[jobRunner] total businesses found:', businessesFound, 'for job', jobId);
    db.update(scrapeJobs).set({ businessesFound }).where(eq(scrapeJobs.id, jobId)).run();
    broadcast('job:scraped', { jobId, count: businessesFound });

    db.update(scrapeJobs).set({ status: 'enriching' }).where(eq(scrapeJobs.id, jobId)).run();
    try {
      await enrichJob(jobId, ac.signal);
      if (!ac.signal.aborted) {
        await enrichLocationJob(jobId, ac.signal);
      }
    } catch (enrichErr) {
      if (ac.signal.aborted) return;
      const enrichMsg = enrichErr instanceof Error ? enrichErr.message : 'Unknown enrichment error';
      console.error(`[jobRunner] enrichJob failed for ${jobId}:`, enrichErr);
      db.update(scrapeJobs).set({ status: 'error', errorMessage: enrichMsg }).where(eq(scrapeJobs.id, jobId)).run();
      broadcast('job:error', { jobId, message: enrichMsg });
      return;
    }
    if (ac.signal.aborted) return;

    db.update(scrapeJobs)
      .set({ status: 'done', completedAt: new Date().toISOString() })
      .where(eq(scrapeJobs.id, jobId))
      .run();
    broadcast('job:done', { jobId });
  } catch (err) {
    if (ac.signal.aborted) return;
    const message = err instanceof Error ? err.message : 'Unknown error';
    db.update(scrapeJobs).set({ status: 'error', errorMessage: message }).where(eq(scrapeJobs.id, jobId)).run();
    broadcast('job:error', { jobId, message });
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
const MAX_POLL_ITERATIONS = 360; // 360 × 5s = 30 min

async function pollUntilDone(gosomId: string, signal: AbortSignal): Promise<void> {
  let seenWorking = false;
  for (let i = 0; i < MAX_POLL_ITERATIONS; i++) {
    if (signal.aborted) return;
    const status = await gosom.getJob(gosomId);
    const s = status.Status?.toLowerCase() ?? '';
    if (s === 'error' || s === 'failed') throw new Error('Gosom job failed');
    if (s === 'working' || s === 'running') seenWorking = true;
    if (seenWorking && (s === 'ok' || s === 'completed' || s === 'done' || s === 'finished' || s === 'success')) return;
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
  throw new Error('Job timed out after 30 minutes');
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
