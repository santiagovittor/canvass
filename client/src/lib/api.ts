import type { ScrapeJob, Business, ExplorerBusiness, BusinessQueryFilters, LocationHierarchy } from '../types';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

export function startScrape(payload: {
  geometry: { type: string; coordinates: number[][][] };
  searchTerm: string;
  language: string;
  gridCellKm: number;
  extractEmails: boolean;
}) {
  return request<{ jobId: string }>('/scrape', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// City tiling (slice 0037): resolve an area name to a bbox preview, then dispatch
// the whole-city sweep through the same async job pipeline as a map-drawn polygon.
export interface CityResolveResult {
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  displayName: string;
  kind: string;
  cellCount: number;
  totalJobs: number;
}

export function resolveCityArea(payload: { area: string; countryHint?: string; gridCellKm?: number }) {
  return request<CityResolveResult>('/scrape/city/resolve', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function startCityScrape(payload: {
  area: string;
  keyword: string;
  language: string;
  gridCellKm?: number;
  countryHint?: string;
}) {
  return request<{ jobId: string }>('/scrape/city', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getJob(jobId: string) {
  return request<ScrapeJob>(`/jobs/${jobId}`);
}

export function listJobs() {
  return request<ScrapeJob[]>('/jobs');
}

export function cancelJob(jobId: string) {
  return request<{ ok: boolean }>(`/jobs/${jobId}`, { method: 'DELETE' });
}

export function resumeJob(jobId: string) {
  return request<{ ok: boolean }>(`/jobs/${jobId}/resume`, { method: 'POST' });
}

export function getResults(jobId: string, q?: string, page = 1) {
  const params = new URLSearchParams({ jobId, page: String(page) });
  if (q) params.set('q', q);
  return request<Business[]>(`/results?${params}`);
}

export function exportToSheets() {
  return request<{ ok: boolean; rowsExported: number }>('/export/sheets', {
    method: 'POST',
  });
}

export function getBusinessCategories() {
  return request<string[]>('/businesses/categories');
}

export function getBusinesses(filters: BusinessQueryFilters) {
  const params = new URLSearchParams();
  if (filters.search)                        params.set('search', filters.search);
  if (filters.locCountry)                    params.set('locCountry', filters.locCountry);
  if (filters.locState)                      params.set('locState', filters.locState);
  if (filters.locCity)                       params.set('locCity', filters.locCity);
  if (filters.category)                      params.set('category', filters.category);
  if (filters.hasEmail)                      params.set('hasEmail', 'true');
  if (filters.hasPhone)                      params.set('hasPhone', 'true');
  if (filters.hasWebsite)                    params.set('hasWebsite', 'true');
  if (filters.hasSocial)                     params.set('hasSocial', 'true');
  if (filters.minRating !== undefined)       params.set('minRating', String(filters.minRating));
  if (filters.orderBy)                       params.set('orderBy', filters.orderBy);
  if (filters.orderDir)                      params.set('orderDir', filters.orderDir);
  if (filters.page)                          params.set('page', String(filters.page));
  if (filters.pageSize)                      params.set('pageSize', String(filters.pageSize));
  return request<{ rows: ExplorerBusiness[]; total: number; page: number; pageSize: number; withEmail: number; contacted: number }>(
    `/businesses?${params}`,
  );
}

export function getLocationHierarchy(filters: Pick<BusinessQueryFilters, 'search' | 'category' | 'hasEmail' | 'hasPhone' | 'hasWebsite' | 'hasSocial' | 'minRating'>) {
  const params = new URLSearchParams();
  if (filters.search)                  params.set('search', filters.search);
  if (filters.category)                params.set('category', filters.category);
  if (filters.hasEmail)                params.set('hasEmail', 'true');
  if (filters.hasPhone)                params.set('hasPhone', 'true');
  if (filters.hasWebsite)              params.set('hasWebsite', 'true');
  if (filters.hasSocial)               params.set('hasSocial', 'true');
  if (filters.minRating !== undefined) params.set('minRating', String(filters.minRating));
  return request<LocationHierarchy>(`/businesses/location-hierarchy?${params}`);
}

export function patchOutreach(id: string, status: string | null) {
  return request<Record<string, unknown>>(`/businesses/${id}/outreach`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function exportExplorerToSheets(filters: BusinessQueryFilters) {
  return request<{ ok: boolean; rowsExported: number }>('/export/sheets/explorer', {
    method: 'POST',
    body: JSON.stringify(filters),
  });
}

export function getConfig() {
  return request<{ senderName: string; senderEmail: string }>('/config');
}

// ── Settings (live config surface) ────────────────────────────────────────────
export type SettingType =
  | 'number' | 'string' | 'enum' | 'boolean' | 'time' | 'weekdays' | 'signature' | 'secret';
export type SettingValue = number | string | boolean | number[];
export type SettingSource = 'default' | 'env' | 'db' | 'file';

export interface SettingFieldView {
  key: string;
  label: string;
  type: SettingType;
  group: string;
  unit?: string;
  min?: number;
  max?: number;
  enum?: string[];
  isSecret?: boolean;
  fileBacked?: boolean;
  help?: string;
  value?: SettingValue;
  source?: SettingSource;
  secret?: { isSet: boolean; last4: string | null };
}
export interface SettingsView {
  groups: { name: string; fields: SettingFieldView[] }[];
}

export function getSettings() {
  return request<SettingsView>('/settings');
}

// Bulk write (one group's Save). Returns the applied effective values, or throws an
// Error whose message carries the 400 body `{ field, error }` for inline display.
export function updateSettings(patch: Record<string, SettingValue>) {
  return request<{ applied: Record<string, SettingValue> }>('/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function updateSetting(key: string, value: SettingValue) {
  return request<{ key: string; value: SettingValue }>(`/settings/${key}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

export function resetSetting(key: string) {
  return request<{ key: string; value: SettingValue }>(`/settings/${key}/reset`, {
    method: 'POST',
  });
}

export function exportToSheetsWithColumns(
  filters: BusinessQueryFilters,
  columns: string[],
  count: number,
): Promise<{ url: string; tabName: string; rowCount: number }> {
  return request<{ url: string; tabName: string; rowCount: number }>('/businesses/export-sheets', {
    method: 'POST',
    body: JSON.stringify({ ...filters, columns, count }),
  });
}
