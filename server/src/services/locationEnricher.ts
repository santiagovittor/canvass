import { request } from 'undici';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { businesses } from '../db/schema';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

interface NominatimAddress {
  country?: string;
  state?: string;
  province?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  suburb?: string;
  neighbourhood?: string;
  quarter?: string;
}

// Reverse-geocode one business via Nominatim. Returns false on failure —
// locationEnriched stays 0 so the row retries after a restart; the caller
// (enrichmentQueue) skips it in-process to keep the queue draining.
export async function enrichLocation(biz: typeof businesses.$inferSelect): Promise<boolean> {
  try {
    const url = `${NOMINATIM_URL}?lat=${biz.latitude}&lon=${biz.longitude}&format=json`;
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: {
        'user-agent': 'maps-scraper/1.0',
        'accept-language': 'en',
      },
      bodyTimeout: 10000,
      headersTimeout: 10000,
    });

    if (statusCode !== 200) throw new Error(`Nominatim returned ${statusCode}`);

    const json = await body.json() as { address?: NominatimAddress };
    const addr = json.address ?? {};

    db.update(businesses)
      .set({
        locCountry: addr.country ?? null,
        locState: addr.state ?? addr.province ?? null,
        locCity: addr.city ?? addr.town ?? addr.village ?? addr.county ?? null,
        locNeighbourhood: addr.suburb ?? addr.neighbourhood ?? addr.quarter ?? null,
        locationEnriched: 1,
      })
      .where(eq(businesses.id, biz.id))
      .run();
    return true;
  } catch (err) {
    console.error(`[locationEnricher] failed for business ${biz.id}:`, err);
    return false;
  }
}
