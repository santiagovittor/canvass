import { queryBusinesses, getDistinctCategories, getLocationHierarchy, updateOutreach, BusinessFilters } from '../db';

export type { BusinessFilters };

export function listBusinesses(filters: BusinessFilters) {
  return queryBusinesses(filters);
}

export function listCategories(): string[] {
  return getDistinctCategories();
}

export function listLocationHierarchy(
  filters: Omit<BusinessFilters, 'page' | 'pageSize' | 'orderBy' | 'locCountry' | 'locState' | 'locCity'>,
) {
  return getLocationHierarchy(filters);
}

export function patchOutreach(id: string, status: string | null, note?: string | null) {
  return updateOutreach(id, status, note);
}

export function exportBusinesses(filters: BusinessFilters) {
  const { rows } = queryBusinesses({ ...filters, page: 1, pageSize: 10000 });
  return rows;
}
