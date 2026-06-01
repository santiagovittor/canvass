import { Router } from 'express';
import { listBusinesses, listCategories, listLocationHierarchy, exportBusinesses, BusinessFilters } from '../services/businesses';
import { buildTabName, createExportTab, parseEmails } from '../services/sheets';

const router = Router();

const VALID_ORDER = ['name', 'rating', 'reviewCount', 'scraped_at'] as const;

function parseFilters(q: Record<string, unknown>): BusinessFilters {
  const orderBy = VALID_ORDER.includes(q.orderBy as typeof VALID_ORDER[number])
    ? (q.orderBy as BusinessFilters['orderBy'])
    : 'scraped_at';

  return {
    search:      typeof q.search === 'string' && q.search ? q.search : undefined,
    locCountry:  typeof q.locCountry === 'string' && q.locCountry ? q.locCountry : undefined,
    locState:    typeof q.locState === 'string' && q.locState ? q.locState : undefined,
    locCity:     typeof q.locCity === 'string' && q.locCity ? q.locCity : undefined,
    category:    typeof q.category === 'string' && q.category ? q.category : undefined,
    hasEmail:    q.hasEmail === 'true' ? true : undefined,
    hasPhone:    q.hasPhone === 'true' ? true : undefined,
    hasWebsite:  q.hasWebsite === 'true' ? true : undefined,
    hasSocial:   q.hasSocial === 'true' ? true : undefined,
    minRating:   q.minRating ? parseFloat(q.minRating as string) : undefined,
    orderBy,
    orderDir:    q.orderDir === 'asc' ? 'asc' as const : 'desc' as const,
    page:        q.page ? Math.max(1, parseInt(q.page as string, 10)) : 1,
    pageSize:    q.pageSize ? Math.min(500, Math.max(1, parseInt(q.pageSize as string, 10))) : 50,
  };
}

function firstEmail(emailsJson: string | null): string | null {
  if (!emailsJson) return null;
  try {
    const parsed = JSON.parse(emailsJson);
    if (typeof parsed === 'string') return parsed || null;
    if (Array.isArray(parsed)) return (parsed[0] as string) ?? null;
    return null;
  } catch {
    return null;
  }
}

router.get('/', (req, res) => {
  const filters = parseFilters(req.query as Record<string, unknown>);
  const { rows, total, withEmail, contacted } = listBusinesses(filters);

  const out = rows.map(({ emailsJson, ...b }) => ({
    ...b,
    email: firstEmail(emailsJson),
  }));

  res.json({ rows: out, total, page: filters.page, pageSize: filters.pageSize, withEmail, contacted });
});

router.get('/categories', (_req, res) => {
  res.json(listCategories());
});

router.get('/location-hierarchy', (req, res) => {
  const { search, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating } =
    parseFilters(req.query as Record<string, unknown>);
  res.json(listLocationHierarchy({ search, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating }));
});

function parseFiltersFromBody(b: Record<string, unknown>): BusinessFilters {
  const orderBy = VALID_ORDER.includes(b.orderBy as typeof VALID_ORDER[number])
    ? (b.orderBy as BusinessFilters['orderBy'])
    : 'scraped_at';
  return {
    search:     typeof b.search === 'string' && b.search ? b.search : undefined,
    locCountry: typeof b.locCountry === 'string' && b.locCountry ? b.locCountry : undefined,
    locState:   typeof b.locState === 'string' && b.locState ? b.locState : undefined,
    locCity:    typeof b.locCity === 'string' && b.locCity ? b.locCity : undefined,
    category:   typeof b.category === 'string' && b.category ? b.category : undefined,
    hasEmail:   b.hasEmail === true ? true : undefined,
    hasPhone:   b.hasPhone === true ? true : undefined,
    hasWebsite: b.hasWebsite === true ? true : undefined,
    hasSocial:  b.hasSocial === true ? true : undefined,
    minRating:  typeof b.minRating === 'number' ? b.minRating : undefined,
    orderBy,
    orderDir:   b.orderDir === 'asc' ? 'asc' as const : 'desc' as const,
    page:       1,
    pageSize:   10000,
  };
}

type BusinessRow = ReturnType<typeof exportBusinesses>[number];

const COLUMN_MAP: Record<string, { header: string; getValue: (b: BusinessRow) => string | number | null }> = {
  name:        { header: 'Name',         getValue: b => b.name },
  category:    { header: 'Category',     getValue: b => b.category ?? null },
  address:     { header: 'Address',      getValue: b => b.address ?? null },
  phone:       { header: 'Phone',        getValue: b => b.phone ?? null },
  email:       { header: 'Email',        getValue: b => parseEmails(b.emailsJson)[0] ?? null },
  website:     { header: 'Website',      getValue: b => b.website ?? null },
  instagram:   { header: 'Instagram',    getValue: b => b.instagram ?? null },
  facebook:    { header: 'Facebook',     getValue: b => b.facebook ?? null },
  linkedin:    { header: 'LinkedIn',     getValue: b => b.linkedin ?? null },
  twitter:     { header: 'Twitter',      getValue: b => b.twitter ?? null },
  tiktok:      { header: 'TikTok',       getValue: b => b.tiktok ?? null },
  youtube:     { header: 'YouTube',      getValue: b => b.youtube ?? null },
  rating:      { header: 'Rating',       getValue: b => b.rating ?? null },
  reviewCount: { header: 'Review Count', getValue: b => b.reviewCount ?? null },
  placeId:     { header: 'Place ID',     getValue: b => b.id },
  scrapedAt:   { header: 'Scraped At',   getValue: b => b.scrapedAt },
};

router.post('/export-sheets', async (req, res) => {
  try {
    const body = req.body ?? {};
    const filters = parseFiltersFromBody(body);
    const columns: string[] = Array.isArray(body.columns)
      ? (body.columns as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    const rows = exportBusinesses(filters);
    console.log(`[export] rows=${rows.length} first.emailsJson=${rows[0]?.emailsJson ?? 'N/A'}`);
    const activeCols = columns.filter(c => c in COLUMN_MAP);
    if (activeCols.length === 0) {
      res.status(400).json({ error: 'No valid columns selected' });
      return;
    }
    const headers = activeCols.map(c => COLUMN_MAP[c].header);
    const data = rows.map(r => activeCols.map(c => COLUMN_MAP[c].getValue(r)));
    const tabName = buildTabName(filters, rows.length);
    const { url } = await createExportTab(tabName, headers, data);
    res.json({ url, tabName, rowCount: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    res.status(500).json({ error: message });
  }
});

export { parseFilters };
export default router;
