import { request } from 'undici';
import { eq, and, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { businesses } from '../db/schema';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const RATE_LIMIT_MS = 1100;

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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
  });
}

export async function enrichLocationJob(jobId: string | undefined, signal: AbortSignal): Promise<void> {
  const where = jobId
    ? and(eq(businesses.locationEnriched, 0), isNotNull(businesses.latitude), isNotNull(businesses.longitude), eq(businesses.jobId, jobId))
    : and(eq(businesses.locationEnriched, 0), isNotNull(businesses.latitude), isNotNull(businesses.longitude));

  const bizes = db.select().from(businesses).where(where).all();
  if (bizes.length === 0) return;

  for (let i = 0; i < bizes.length; i++) {
    if (signal.aborted) break;
    const biz = bizes[i];

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
    } catch (err) {
      console.error(`[locationEnricher] failed for business ${biz.id}:`, err);
    }

    if (i < bizes.length - 1 && !signal.aborted) {
      await sleep(RATE_LIMIT_MS, signal);
    }
  }
}
