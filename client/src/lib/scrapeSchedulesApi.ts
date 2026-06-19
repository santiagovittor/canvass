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
  recentRuns?: ScrapeScheduleRunRow[];
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

export interface ScrapeTickCounts {
  due: number;
  ran: number;
  added: number;
  deduped: number;
  errored: number;
  elapsedMs: number;
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

const BASE = '/api/scrape-schedules';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const b = await res.text();
    throw new Error(`${res.status} ${b}`);
  }
  return res.json();
}

export const listScrapeSchedules = () => req<ScrapeScheduleRow[]>('/');

export const createScrapeSchedule = (body: {
  name: string;
  polygon_json: string;
  business_type: string;
  interval_minutes: number;
  enabled?: number;
}) => req<ScrapeScheduleRow>('/', { method: 'POST', body: JSON.stringify(body) });

export const updateScrapeSchedule = (id: string, patch: Partial<ScrapeScheduleRow>) =>
  req<ScrapeScheduleRow>(`/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteScrapeSchedule = (id: string) =>
  req<{ deleted: boolean }>(`/${id}`, { method: 'DELETE' });

export const runScrapeScheduleNow = (id: string) =>
  req<ScrapeScheduleRow>(`/${id}/run-now`, { method: 'POST' });

export const getScrapeSchedulerStatus = () =>
  req<{ health: ScrapeSchedulerHealth; recentRuns: ScrapeScheduleRunRow[] }>('/status');

export const pauseScrapeScheduler = (reason?: string) =>
  req<{ paused: boolean; pausedAt: string | null }>('/pause', { method: 'POST', body: JSON.stringify({ reason }) });

export const resumeScrapeScheduler = () =>
  req<{ paused: boolean }>('/resume', { method: 'POST' });
