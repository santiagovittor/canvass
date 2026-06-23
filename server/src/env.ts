import { z } from 'zod';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_AUTH_USER: z.string().optional(),
  APP_AUTH_PASS: z.string().optional(),
  GOSOM_URL: z.string().url().default('http://localhost:8080'),
  GOSOM_CONTAINER: z.string().default('maps-scraper-gosom'),
  DOCKER_SOCK: z.string().default('/var/run/docker.sock'),
  DATABASE_URL: z.string().default('./data/scraper.db'),
  GOOGLE_SERVICE_ACCOUNT_PATH: z.string().default('./credentials/google-service-account.json'),
  GOOGLE_SHEET_ID: z.string().optional(),
  SOCIAL_ENRICHMENT_DELAY_MS: z.coerce.number().default(1000),
  SOCIAL_ENRICHMENT_TIMEOUT_MS: z.coerce.number().default(8000),
  SOCIAL_ENRICHMENT_MAX_BYTES: z.coerce.number().default(2097152),
  EMAIL_SIGNATURE_PATH: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  GMAIL_FROM: z.string().email().optional(),
  GMAIL_SENDER_NAME: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  PUBLIC_URL: z.string().url().optional(),
  // Unset → premium analysis routes 503 and the queue no-ops (prod-safe before compose update)
  PLAYWRIGHT_WS_URL: z.string().optional(),
  PREMIUM_RENDER_TIMEOUT_MS: z.coerce.number().default(20000),
  PAGESPEED_API_KEY: z.string().optional(),
  // When 'true', the scheduled-send worker exercises the full path but suppresses
  // the SMTP transmit (records a 'dryrun' row, never flips contacted-state).
  // Explicit enum — z.coerce.boolean() would treat the string "false" as true.
  OUTREACH_DRY_RUN: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  // Rolling-24h send cap. Default 15 = fresh sending identity; ramp to 30 warmed.
  OUTREACH_DAILY_CAP: z.coerce.number().int().positive().default(15),
  // Batch automation — single config surface for the bulk-prepare layer.
  // Concurrency is a throttle, not a speed dial: how many leads prepare at once.
  BATCH_PREPARE_CONCURRENCY: z.coerce.number().int().positive().default(3),
  // Per-item analyze timeout (Playwright render + PSI + vision can hang).
  BATCH_ANALYZE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  // Gemini throttle. RPM enforced in-memory by Bottleneck; keep below the tier limit.
  // Default tuned to Tier-1 headroom for fast generation (minTime = 60000/RPM ms).
  GEMINI_RPM: z.coerce.number().int().positive().default(120),
  // Gemini daily request budget — persisted, Pacific-date keyed. Conservative default;
  // tune to the account tier. Retries are absorbed by the margin below the real ceiling.
  GEMINI_RPD: z.coerce.number().int().positive().default(1000),
  GEMINI_COMPOSER_FALLBACK_MODEL: z.string().default('gemini-3-flash'),
  // Pre-compose email-validity gate (slice 0013). SMTP RCPT probe ON by default
  // (operator: real emails is key) — degrades gracefully to 'unknown' when port 25
  // is blocked/greylisted, never blocks the pipeline. Explicit enum — z.coerce.boolean
  // treats "false" as true.
  EMAIL_VERIFY_SMTP_PROBE: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  // Per-address probe budget: bounds DNS MX + the full SMTP handshake. Mirrors the
  // SOCIAL_ENRICHMENT_TIMEOUT_MS discipline so a slow MX can't stall a batch.
  EMAIL_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // Re-probe TTL: a cached validity result older than this is re-checked.
  EMAIL_VERIFY_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(30),
}).refine(
  d => (d.APP_AUTH_USER == null) === (d.APP_AUTH_PASS == null),
  { message: 'AUTH_USER and AUTH_PASS must both be set or both be unset' },
);

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  const flat = parsed.error.flatten();
  console.error(flat.fieldErrors);
  if (flat.formErrors.length) console.error(flat.formErrors);
  process.exit(1);
}

export const env = parsed.data;
