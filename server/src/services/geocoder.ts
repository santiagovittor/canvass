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

// Pick-aware resolve (slice 0041). A GeoNames pick already carries the exact
// centroid; the old path threw it away and re-resolved a "name, admin1, CODE"
// string through Nominatim — landing a homonym (the Belgrano→Santa-Fe-station
// bug). Here we bias Nominatim to a box around the picked point, validate the
// hit is near it, and otherwise fall back to a population-scaled box on the
// exact point — so a pick can never silently scrape hundreds of km away.

export interface PickedArea {
  name: string;          // bare gazetteer name, used as the Nominatim query
  country: string | null; // ISO-2, biases Nominatim via countrycodes
  lat: number;
  lon: number;
  population: number;
}

// Population → bbox half-extent (km). The calibration knob — tuned for AR cities.
// ponytail: static bands; widen/narrow per-pick only if coverage complaints appear.
function popToRadiusKm(pop: number): number {
  if (pop < 20_000) return 3;
  if (pop < 100_000) return 5;
  if (pop < 500_000) return 10;
  if (pop < 2_000_000) return 15;
  return 25;
}

// Cheap equirectangular distance (km) — adequate at city scale.
function equirectKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const x = ((bLon - aLon) * Math.PI / 180) * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
  const y = (bLat - aLat) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * 6371;
}

function centroidBox(lat: number, lon: number, radiusKm: number): Bbox {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

// Area-like Nominatim addresstypes. Rejects same-name POIs (railway/amenity/
// building) — the Belgrano-railway-station false positive sits in the viewbox
// too, so type-filtering, not just distance, is what isolates the real barrio.
const AREA_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter',
  'borough', 'municipality', 'administrative', 'boundary', 'county', 'state',
  'region', 'province', 'locality', 'district', 'city_district',
]);

export async function resolvePickedArea(p: PickedArea, displayLabel: string): Promise<ResolvedArea> {
  const radiusKm = popToRadiusKm(p.population);
  // Give Nominatim room to return a real boundary without letting it wander far.
  const vb = centroidBox(p.lat, p.lon, radiusKm * 2);
  const params = new URLSearchParams({
    q: p.name.trim(),
    format: 'json',
    limit: '10',
    bounded: '1',
    // viewbox order: x1(west),y1(north),x2(east),y2(south)
    viewbox: `${vb.minLon},${vb.maxLat},${vb.maxLon},${vb.minLat}`,
  });
  if (p.country) params.set('countrycodes', p.country.toLowerCase());

  let hits: NominatimHit[] = [];
  try {
    const url = `${env.GEOCODER_URL}/search?${params}`;
    hits = await rateLimited(async () => {
      console.log(`[geocoder] biased resolve "${p.name}" near (${p.lat},${p.lon})`);
      const { statusCode, body } = await request(url, {
        method: 'GET',
        headers: { 'user-agent': 'maps-scraper/1.0 (city-tiling)', accept: 'application/json' },
      });
      if (statusCode >= 400) {
        const text = await body.text();
        throw new Error(`Geocoder ${statusCode}: ${text.slice(0, 200)}`);
      }
      const arr = (await body.json()) as NominatimHit[];
      return Array.isArray(arr) ? arr : [];
    });
  } catch (err) {
    // Rate-limit/network failure must never block a pick — fall through to centroid box.
    console.log(`[geocoder] biased resolve failed, using centroid box: ${err instanceof Error ? err.message : err}`);
  }

  // First area-typed hit that's near the pick and city-sized wins. Type-filter
  // first so a same-name station/amenity in the box can't shadow the real area.
  for (const hit of hits) {
    const kind = hit.addresstype ?? hit.type ?? '';
    if (!AREA_TYPES.has(kind)) continue;
    const bb = hit.boundingbox;
    if (!bb || bb.length !== 4) continue;
    const [south, north, west, east] = bb.map(parseFloat);
    if ([south, north, west, east].some(Number.isNaN)) continue;
    const cLat = (south + north) / 2, cLon = (west + east) / 2;
    const nearPick = equirectKm(p.lat, p.lon, cLat, cLon) <= 50;
    const spanKm = Math.max(
      equirectKm(south, cLon, north, cLon),
      equirectKm(cLat, west, cLat, east),
    );
    if (nearPick && spanKm > 1) {
      return {
        bbox: { minLat: south, maxLat: north, minLon: west, maxLon: east },
        displayName: hit.display_name ?? displayLabel,
        kind,
      };
    }
  }

  return { bbox: centroidBox(p.lat, p.lon, radiusKm), displayName: displayLabel, kind: 'centroid-box' };
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
