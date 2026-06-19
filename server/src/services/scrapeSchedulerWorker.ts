import { sqlite } from '../db';
import {
  getDueSchedules, claimScheduleRun, finishScheduleRun,
  reapStaleRuns, updateScheduleAfterRun,
} from '../db/scrapeSchedules';
import { getBool, setSetting } from './appSettings';
import { runJobSync, runKeywordJobSync } from './jobRunner';

const TICK_INTERVAL_MS = 60_000;
const FIRST_TICK_DELAY_MS = 15_000;
const STALE_MS = 45 * 60_000;

let running = false;

export interface ScrapeTickCounts {
  due: number; ran: number; added: number; deduped: number; errored: number; elapsedMs: number;
}
export interface ScrapeSchedulerHealth {
  lastTickAt: string | null;
  ticksTotal: number;
  lastTickCounts: ScrapeTickCounts;
  intervalMs: number;
  nextTickEtaMs: number;
  paused: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
}

let _lastTickAt: string | null = null;
let _ticksTotal = 0;
let _lastTickCounts: ScrapeTickCounts = { due: 0, ran: 0, added: 0, deduped: 0, errored: 0, elapsedMs: 0 };
let _lastTickEndedAt = 0;
let _pausedAt: string | null = null;
let _pausedReason: string | null = null;

export function getScrapeSchedulerHealth(): ScrapeSchedulerHealth {
  const nextTickEtaMs = _lastTickEndedAt > 0
    ? Math.max(0, _lastTickEndedAt + TICK_INTERVAL_MS - Date.now())
    : FIRST_TICK_DELAY_MS;
  return {
    lastTickAt: _lastTickAt,
    ticksTotal: _ticksTotal,
    lastTickCounts: { ..._lastTickCounts },
    intervalMs: TICK_INTERVAL_MS,
    nextTickEtaMs,
    paused: getBool('SCRAPE_SCHEDULES_PAUSED'),
    pausedAt: _pausedAt,
    pausedReason: _pausedReason,
  };
}

export function setScrapeSchedulerPaused(paused: boolean, reason?: string): void {
  setSetting('SCRAPE_SCHEDULES_PAUSED', paused);
  if (paused) {
    _pausedAt = new Date().toISOString();
    _pausedReason = reason ?? null;
  } else {
    _pausedAt = null;
    _pausedReason = null;
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  const tickStart = Date.now();
  const counts: ScrapeTickCounts = { due: 0, ran: 0, added: 0, deduped: 0, errored: 0, elapsedMs: 0 };

  try {
    const reaped = reapStaleRuns(new Date(Date.now() - STALE_MS).toISOString());
    if (reaped > 0) console.log(`[scrape-scheduler] reaped ${reaped} stale run(s)`);

    const paused = getBool('SCRAPE_SCHEDULES_PAUSED');
    if (!paused) {
      const due = getDueSchedules();
      counts.due = due.length;

      for (const schedule of due) {
        const runId = claimScheduleRun(schedule.id);
        if (runId === null) {
          console.log(`[scrape-scheduler] concurrency block — another run active, deferring ${due.length - counts.ran} due schedule(s)`);
          break;
        }
        try {
          const kind = (schedule.kind ?? 'polygon') as 'polygon' | 'keyword';
          if (kind === 'keyword') {
            if (!schedule.keyword_query) throw new Error('keyword_query is null for keyword schedule');
            const { added, deduped } = await runKeywordJobSync({
              query: schedule.keyword_query,
              lang: schedule.language ?? 'en',
              depth: schedule.depth ?? undefined,
              geoBias: schedule.geo_lat
                ? { lat: schedule.geo_lat, lon: schedule.geo_lng!, radius: schedule.geo_radius! }
                : undefined,
            });
            finishScheduleRun(runId, 'ok', added, deduped);
            updateScheduleAfterRun(schedule.id, 'ok', added);
            counts.ran++;
            counts.added += added;
            counts.deduped += deduped;
          } else {
            // polygon mode — language + gridCellKm now come from the schedule row
            const params = {
              geometry: JSON.parse(schedule.polygon_json),
              searchTerm: schedule.business_type,
              language: schedule.language ?? 'es',
              gridCellKm: schedule.grid_cell_km ?? 0.4,
              extractEmails: true,
            };
            const { jobId, businessesFound } = await runJobSync(params);
            const addedRow = sqlite.prepare('SELECT COUNT(*) as n FROM businesses WHERE job_id = ?').get(jobId) as { n: number };
            const addedCount = addedRow.n;
            const dedupedCount = Math.max(0, businessesFound - addedCount);
            finishScheduleRun(runId, 'ok', addedCount, dedupedCount);
            updateScheduleAfterRun(schedule.id, 'ok', addedCount);
            counts.ran++;
            counts.added += addedCount;
            counts.deduped += dedupedCount;
          }
        } catch (err) {
          counts.errored++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[scrape-scheduler] error schedule=${schedule.id}:`, msg);
          finishScheduleRun(runId, 'error', 0, 0, msg);
          updateScheduleAfterRun(schedule.id, 'error', 0, msg);
        }
        // One run per tick max (single scraper container)
        break;
      }
    }
  } catch (err) {
    console.error('[scrape-scheduler] tick-level error:', err instanceof Error ? err.message : err);
  } finally {
    counts.elapsedMs = Date.now() - tickStart;
    _lastTickAt = new Date().toISOString();
    _lastTickEndedAt = Date.now();
    _ticksTotal++;
    _lastTickCounts = { ...counts };
    const paused = getBool('SCRAPE_SCHEDULES_PAUSED');
    console.log(
      `[scrape-scheduler] tick due=${counts.due} ran=${counts.ran} added=${counts.added} deduped=${counts.deduped} errored=${counts.errored} paused=${paused} elapsedMs=${counts.elapsedMs}`,
    );
    running = false;
  }
}

export function startScrapeSchedulerWorker(): void {
  const run = () => {
    tick().catch(err => console.error('[scrape-scheduler]', err instanceof Error ? err.message : err));
  };
  setTimeout(run, FIRST_TICK_DELAY_MS).unref();
  setInterval(run, TICK_INTERVAL_MS).unref();
}
