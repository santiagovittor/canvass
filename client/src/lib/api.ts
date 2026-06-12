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
