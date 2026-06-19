const BASE = '/api/keyword-scrape';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export interface InstantScrapeParams {
  query: string;
  lang?: string;
  depth?: number;
  geoBias?: { lat: string; lon: string; radius: number };
}

export interface InstantScrapeResult {
  added: number;
  deduped: number;
  businessIds: string[];
}

export function instantKeywordScrape(params: InstantScrapeParams): Promise<InstantScrapeResult> {
  return req('/instant', { method: 'POST', body: JSON.stringify(params) });
}
