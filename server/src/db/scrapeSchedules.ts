import { randomBytes } from 'crypto';
import { sqlite } from './index';

export interface ScrapeScheduleRow {
  id: string;
  name: string;
  polygon_json: string;
  business_type: string;
  interval_minutes: number;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string;
  last_run_status: string | null;
  last_run_added_count: number | null;
  last_run_error: string | null;
  created_at: string;
  updated_at: string;
  kind: string;
  language: string | null;
  grid_cell_km: number | null;
  keyword_query: string | null;
  geo_lat: string | null;
  geo_lng: string | null;
  geo_radius: number | null;
  depth: number | null;
}

export interface ScrapeScheduleRunRow {
  id: string;
  schedule_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  added_count: number;
  deduped_count: number;
  error: string | null;
}

export function createSchedule(params: {
  name: string;
  polygon_json: string;
  business_type: string;
  interval_minutes: number;
  enabled: number;
}): ScrapeScheduleRow {
  const id = randomBytes(12).toString('base64url');
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO scrape_schedules (id, name, polygon_json, business_type, interval_minutes, enabled, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.name, params.polygon_json, params.business_type, params.interval_minutes, params.enabled, now, now, now);
  return getSchedule(id)!;
}

export function listSchedules(): ScrapeScheduleRow[] {
  return sqlite.prepare('SELECT * FROM scrape_schedules ORDER BY created_at DESC').all() as ScrapeScheduleRow[];
}

export function getSchedule(id: string): ScrapeScheduleRow | null {
  return (sqlite.prepare('SELECT * FROM scrape_schedules WHERE id = ?').get(id) ?? null) as ScrapeScheduleRow | null;
}

export function updateSchedule(id: string, patch: Partial<{
  name: string;
  polygon_json: string;
  business_type: string;
  interval_minutes: number;
  enabled: number;
  next_run_at: string;
}>): ScrapeScheduleRow | null {
  const row = getSchedule(id);
  if (!row) return null;
  const now = new Date().toISOString();
  const merged = { ...row, ...patch, updated_at: now };
  // Recompute next_run_at if interval changed and we haven't overridden it explicitly
  if (patch.interval_minutes !== undefined && patch.next_run_at === undefined) {
    const base = row.last_run_at ?? now;
    merged.next_run_at = new Date(new Date(base).getTime() + merged.interval_minutes * 60_000).toISOString();
  }
  sqlite.prepare(`
    UPDATE scrape_schedules
    SET name=?, polygon_json=?, business_type=?, interval_minutes=?, enabled=?, next_run_at=?, updated_at=?
    WHERE id=?
  `).run(merged.name, merged.polygon_json, merged.business_type, merged.interval_minutes, merged.enabled, merged.next_run_at, now, id);
  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  const info = sqlite.prepare('DELETE FROM scrape_schedules WHERE id = ?').run(id);
  return info.changes === 1;
}

export function getDueSchedules(): ScrapeScheduleRow[] {
  return sqlite.prepare(
    `SELECT * FROM scrape_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC`
  ).all(new Date().toISOString()) as ScrapeScheduleRow[];
}

// Atomic claim: inserts a 'running' run row only if no run is already running.
// Returns the run id on success, null if another run is active.
export function claimScheduleRun(scheduleId: string): string | null {
  const runId = randomBytes(12).toString('base64url');
  const now = new Date().toISOString();
  const info = sqlite.prepare(`
    INSERT INTO scrape_schedule_runs (id, schedule_id, started_at, status, added_count, deduped_count)
    SELECT ?, ?, ?, 'running', 0, 0
    WHERE NOT EXISTS (SELECT 1 FROM scrape_schedule_runs WHERE status = 'running')
  `).run(runId, scheduleId, now);
  return info.changes === 1 ? runId : null;
}

export function finishScheduleRun(
  runId: string,
  status: 'ok' | 'error',
  addedCount: number,
  dedupedCount: number,
  error?: string,
): void {
  sqlite.prepare(`
    UPDATE scrape_schedule_runs
    SET finished_at=?, status=?, added_count=?, deduped_count=?, error=?
    WHERE id=?
  `).run(new Date().toISOString(), status, addedCount, dedupedCount, error ?? null, runId);
}

export function reapStaleRuns(olderThan: string): number {
  const info = sqlite.prepare(`
    UPDATE scrape_schedule_runs SET status='error', error='stale', finished_at=?
    WHERE status='running' AND started_at < ?
  `).run(new Date().toISOString(), olderThan);
  return info.changes;
}

export function updateScheduleAfterRun(
  id: string,
  status: 'ok' | 'error',
  addedCount: number,
  error?: string,
): void {
  const now = new Date().toISOString();
  const row = getSchedule(id);
  if (!row) return;
  const nextRunAt = new Date(Date.now() + row.interval_minutes * 60_000).toISOString();
  sqlite.prepare(`
    UPDATE scrape_schedules
    SET last_run_at=?, last_run_status=?, last_run_added_count=?, last_run_error=?, next_run_at=?, updated_at=?
    WHERE id=?
  `).run(now, status, addedCount, error ?? null, nextRunAt, now, id);
}

export function getRecentRuns(opts: { scheduleId?: string; limit?: number } = {}): ScrapeScheduleRunRow[] {
  const limit = opts.limit ?? 20;
  if (opts.scheduleId) {
    return sqlite.prepare(
      'SELECT * FROM scrape_schedule_runs WHERE schedule_id=? ORDER BY started_at DESC LIMIT ?'
    ).all(opts.scheduleId, limit) as ScrapeScheduleRunRow[];
  }
  return sqlite.prepare(
    'SELECT * FROM scrape_schedule_runs ORDER BY started_at DESC LIMIT ?'
  ).all(limit) as ScrapeScheduleRunRow[];
}
