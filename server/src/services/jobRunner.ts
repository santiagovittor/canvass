import { randomBytes } from 'crypto';
import { eq, sql } from 'drizzle-orm';
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

  db.insert(scrapeJobs).values({
    id: jobId,
    searchTerm: params.searchTerm,
    language: params.language,
    bboxJson: JSON.stringify(bbox),
    gridCellKm: params.gridCellKm,
    cellCount: count,
    status: 'pending',
    createdAt: now,
  }).run();

  runJob(jobId, params, bbox, count).catch(err => {
    console.error(`Job ${jobId} unhandled error:`, err);
  });

  return jobId;
}

async function runJob(
  jobId: string,
  params: StartJobParams,
  bbox: ReturnType<typeof bboxFromGeoJSON>,
  count: number,
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
    let cellsDone = 0;
    let jobsDone = 0;
    let businessesFound = 0;

    db.update(scrapeJobs).set({ status: 'running', cellCount: totalCells }).where(eq(scrapeJobs.id, jobId)).run();
    broadcast('job:started', { jobId, cellCount: totalCells, totalJobs });

    for (let i = 0; i < cells.length; i++) {
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

        console.log('[jobRunner] downloading results for gosom job', gosomId, 'category:', category);
        const rawResults = await gosom.downloadResults(gosomId);
        console.log('[jobRunner] downloaded', rawResults?.length, 'results for gosom job', gosomId);
        if (rawResults.length > 0) console.log('[jobRunner] sample first result keys:', Object.keys(rawResults[0]));
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
        const progressPayload = { jobId, cellsDone, totalCells, jobsDone, jobsTotal: totalJobs, newBusinesses: countInserted, totalBusinesses: businessesFound };
        console.log('[jobRunner] broadcasting job:progress', JSON.stringify(progressPayload));
        broadcast('job:progress', progressPayload);
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
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
  });
}

async function pollUntilDone(gosomId: string, signal: AbortSignal): Promise<void> {
  let seenWorking = false;
  const MAX_ITERATIONS = 360; // 360 × 5s = 30 min
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) return;
    const status = await gosom.getJob(gosomId);
    const s = status.Status?.toLowerCase() ?? '';
    console.log('[pollUntilDone] gosom job', gosomId, 'status:', s);
    if (s === 'error' || s === 'failed') throw new Error('Gosom job failed');
    if (s === 'working' || s === 'running') seenWorking = true;
    if (seenWorking && (s === 'ok' || s === 'completed' || s === 'done' || s === 'finished' || s === 'success')) return;
    await abortableDelay(5000, signal);
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
