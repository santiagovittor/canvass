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
  // Second sender (slice 0027). Same App Password mechanism as sender #1. Both vars
  // of the pair must be set together — see the refine below (clear boot error if a
  // configured sender is missing its password). Display name is shared (same person).
  GMAIL_FROM_2: z.string().email().optional(),
  GMAIL_APP_PASSWORD_2: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // NVIDIA NIM (OpenAI-compatible) provider for the compose/verify text task (slice 0026).
  // Key optional; a `nim:` model selected without the key throws a clear error at call time.
  NVIDIA_NIM_API_KEY: z.string().optional(),
  NVIDIA_NIM_BASE_URL: z.string().url().default('https://integrate.api.nvidia.com'),
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
  // Per-item compose timeout (slice 0023). composeVerifiedEmail can issue ~12 Gemini
  // calls; each bounded by GEMINI_TOTAL_CAP_MS. Ceiling above worst-case-legit, well
  // under "stuck" — a timeout throws → item failed (compose_timeout), batch continues.
  BATCH_COMPOSE_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
  // Run-level stall watchdog (slice 0023). A running run whose updated_at has not
  // advanced within this bound is wedged → its non-terminal items fail (stalled) and
  // the run finalizes. Above worst-case-legit single item (~analyze+compose=300s).
  BATCH_STALL_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  // Gemini throttle. RPM enforced in-memory by Bottleneck; keep below the tier limit.
  // Default tuned to Tier-1 headroom for fast generation (minTime = 60000/RPM ms).
  GEMINI_RPM: z.coerce.number().int().positive().default(120),
  // Gemini daily request budget — persisted, Pacific-date keyed. Conservative default;
  // tune to the account tier. Retries are absorbed by the margin below the real ceiling.
  GEMINI_RPD: z.coerce.number().int().positive().default(1000),
  // Must match settingsRegistry default. gemini-3-flash is a 404 (not a valid id) — never
  // default the resilience fallback to a model that always fails. (slice 0026 review fix)
  GEMINI_COMPOSER_FALLBACK_MODEL: z.string().default('gemini-2.5-flash-lite'),
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
).refine(
  // Truthiness, not null: an empty-string password must error (clear message), not
  // silently drop sender #2 (getSenders treats empty as unconfigured).
  d => (!d.GMAIL_FROM_2) === (!d.GMAIL_APP_PASSWORD_2),
  { message: 'GMAIL_FROM_2 and GMAIL_APP_PASSWORD_2 must both be set or both be unset', path: ['GMAIL_APP_PASSWORD_2'] },
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
