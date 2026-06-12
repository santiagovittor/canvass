import { lookup } from 'dns/promises';
import { request } from 'undici';
import { load, type CheerioAPI } from 'cheerio';
import { eq, and, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { businesses, scrapeJobs } from '../db/schema';
import { broadcast } from '../sse';
import { env } from '../env';

const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^0\.0\.0\.0/,
  /^::1$/,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

function isPrivateIP(ip: string): boolean {
  return PRIVATE_RANGES.some(r => r.test(ip));
}

async function validateURL(urlStr: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Non-http(s) URL');
  }
  const addrs = await lookup(url.hostname, { all: true });
  for (const { address } of addrs) {
    if (isPrivateIP(address)) throw new Error(`SSRF blocked: ${address}`);
  }
}

const SOCIAL_PATTERNS: Record<string, RegExp> = {
  instagram: /instagram\.com\/([A-Za-z0-9_.]+)/,
  facebook: /(?:facebook\.com|fb\.com)\/([A-Za-z0-9_.%-]+)/,
  twitter: /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/,
  tiktok: /tiktok\.com\/@?([A-Za-z0-9_.]+)/,
  linkedin: /linkedin\.com\/(?:in|company)\/([A-Za-z0-9_-]+)/,
  youtube: /(?:youtube\.com\/(?:channel|c|user|@)|youtu\.be\/)([A-Za-z0-9_-]+)/,
};

const SHARE_PATTERN = /sharer\.php|intent\/tweet|intent\/post|login|signup|oauth|auth\b|share\?/i;

function extractSocialLinks($: CheerioAPI): Record<string, string> {
  const links = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.add(href);
  });
  $('meta[property="og:url"]').each((_, el) => {
    const content = $(el).attr('content');
    if (content) links.add(content);
  });

  const found: Record<string, string> = {};
  for (const link of links) {
    if (SHARE_PATTERN.test(link)) continue;
    for (const [platform, re] of Object.entries(SOCIAL_PATTERNS)) {
      if (found[platform]) continue;
      const m = re.exec(link);
      if (m) found[platform] = link;
    }
  }
  return found;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Filter conservatively: noreply variants, image-extension false positives
// ("logo@2x.png" matches EMAIL_RE), and platform/tracking domains. Keep
// contact-prefix inboxes (info@, contacto@, hola@…) — they're the whole point.
const NOREPLY_RE = /^(?:no-?reply|do-?not-?reply|donotreply)/i;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|svg|webp|gif)$/i;
const JUNK_DOMAINS = ['example.com', 'sentry.io', 'wixpress.com', 'googleapis.com', 'sentry-cdn.com', 'schema.org', 'w3.org'];

function isJunkEmail(email: string): boolean {
  const domain = email.split('@')[1] ?? '';
  if (!domain.includes('.')) return true;
  if (IMAGE_EXT_RE.test(domain)) return true;
  if (NOREPLY_RE.test(email)) return true;
  return JUNK_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));
}

function extractEmails(html: string, $: CheerioAPI): string[] {
  const found = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/^mailto:/i.test(href)) return;
    try {
      const addr = decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0]).trim().toLowerCase();
      if (addr.includes('@')) found.add(addr);
    } catch { /* malformed percent-encoding — skip */ }
  });

  for (const m of html.matchAll(EMAIL_RE)) {
    found.add(m[0].toLowerCase());
  }

  return [...found].filter(e => !isJunkEmail(e)).slice(0, 5);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
  });
}

export async function enrichJob(jobId: string, signal: AbortSignal): Promise<void> {
  const job = db.select({ extractEmails: scrapeJobs.extractEmails })
    .from(scrapeJobs)
    .where(eq(scrapeJobs.id, jobId))
    .get();
  const wantEmails = job?.extractEmails === 1;

  const bizes = db.select()
    .from(businesses)
    .where(and(eq(businesses.jobId, jobId), isNotNull(businesses.website)))
    .all();

  const total = bizes.length;
  if (total === 0) return;

  for (let i = 0; i < bizes.length; i++) {
    if (signal.aborted) break;
    const biz = bizes[i];
    if (!biz.website) continue;

    try {
      await validateURL(biz.website);

      const { body } = await request(biz.website, {
        method: 'GET',
        headers: { 'user-agent': 'MapsScraperBot/1.0 (+contact)' },
        bodyTimeout: env.SOCIAL_ENRICHMENT_TIMEOUT_MS,
        headersTimeout: 8000,
      });

      let html = '';
      let bytes = 0;
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        html += buf.toString('utf-8');
        if (bytes >= env.SOCIAL_ENRICHMENT_MAX_BYTES) break;
      }

      const $ = load(html);
      const links = extractSocialLinks($);
      const emails = wantEmails ? extractEmails(html, $) : [];
      db.update(businesses)
        .set({
          instagram: links.instagram ?? null,
          facebook: links.facebook ?? null,
          twitter: links.twitter ?? null,
          tiktok: links.tiktok ?? null,
          linkedin: links.linkedin ?? null,
          youtube: links.youtube ?? null,
          ...(emails.length > 0 ? { emailsJson: JSON.stringify(emails) } : {}),
          socialEnriched: 1,
        })
        .where(eq(businesses.id, biz.id))
        .run();
    } catch {
      db.update(businesses).set({ socialEnriched: 1 }).where(eq(businesses.id, biz.id)).run();
    }

    const done = i + 1;
    db.update(scrapeJobs).set({ enrichmentProgress: done }).where(eq(scrapeJobs.id, jobId)).run();
    broadcast('enrich:progress', { jobId, done, total });

    if (i < bizes.length - 1 && !signal.aborted) {
      await sleep(env.SOCIAL_ENRICHMENT_DELAY_MS, signal);
    }
  }
}
