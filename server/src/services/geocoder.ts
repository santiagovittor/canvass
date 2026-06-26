import { request } from 'undici';
import { env } from '../env';
import type { Bbox } from './grid';
import { searchAreas as searchGeoPlaces, type GeoPlace } from '../db/geo';

// Area autocomplete (slice 0038): prefix search over the self-hosted GeoNames
// gazetteer (population-ranked). Pure DB read — no external call, sub-200ms — so
// it's safe to hit per debounced keystroke. Distinct from resolveAreaToBbox below,
// which stays the authoritative name→bbox resolver (Nominatim; GeoNames has no bbox).
export function searchAreas(prefix: string, limit = 8): GeoPlace[] {
  return searchGeoPlaces(prefix, limit);
}

// Name→bounding-box resolver for city-tiling keyword scrapes (slice 0037).
// Turns a typed city/area name into a map rectangle that the existing polygon
// grid scraper sweeps. Data © OpenStreetMap contributors, ODbL
// (https://www.openstreetmap.org/copyright) — surface attribution in the UI.

export interface ResolvedArea {
  bbox: Bbox;
  displayName: string;
  kind: string; // Nominatim addresstype/type, e.g. "city", "state" — for operator confirmation
}

// A resolved city bbox effectively never changes — cache for the process lifetime.
// ponytail: in-memory only; add a geo_cache table if cross-restart persistence matters.
const cache = new Map<string, ResolvedArea>();

// Nominatim public usage policy: max 1 req/s. Serialize lookups behind a single
// gate so concurrent callers can't burst past it.
let lastRequestAt = 0;
let chain: Promise<unknown> = Promise.resolve();
const MIN_GAP_MS = 1100;

function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this call rejects, so one failure doesn't wedge the gate.
  chain = run.catch(() => {});
  return run;
}

interface NominatimHit {
  // boundingbox: [south, north, west, east] as strings
  boundingbox?: [string, string, string, string];
  display_name?: string;
  addresstype?: string;
  type?: string;
}

export async function resolveAreaToBbox(name: string, countryHint?: string): Promise<ResolvedArea> {
  const query = countryHint ? `${name.trim()}, ${countryHint.trim()}` : name.trim();
  const key = query.toLowerCase();
  const cached = cache.get(key);
  if (cached) {
    console.log(`[geocoder] cache hit for "${query}"`);
    return cached;
  }

  const url = `${env.GEOCODER_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const hit = await rateLimited(async () => {
    console.log(`[geocoder] resolving "${query}" via ${env.GEOCODER_URL}`);
    const { statusCode, body } = await request(url, {
      method: 'GET',
      // Nominatim requires an identifying User-Agent; missing/generic → 403.
      headers: { 'user-agent': 'maps-scraper/1.0 (city-tiling)', accept: 'application/json' },
    });
    if (statusCode >= 400) {
      const text = await body.text();
      throw new Error(`Geocoder ${statusCode}: ${text.slice(0, 200)}`);
    }
    return (await body.json()) as NominatimHit[];
  });

  const top = Array.isArray(hit) ? hit[0] : undefined;
  const bb = top?.boundingbox;
  if (!top || !bb || bb.length !== 4) {
    throw new Error(`Could not resolve "${query}" to a location. Try adding a country or state (e.g. "Orlando, US").`);
  }
  const [south, north, west, east] = bb.map(parseFloat);
  if ([south, north, west, east].some(Number.isNaN)) {
    throw new Error(`Geocoder returned an invalid bounding box for "${query}".`);
  }

  const resolved: ResolvedArea = {
    bbox: { minLat: south, maxLat: north, minLon: west, maxLon: east },
    displayName: top.display_name ?? query,
    kind: top.addresstype ?? top.type ?? 'unknown',
  };
  cache.set(key, resolved);
  return resolved;
}
