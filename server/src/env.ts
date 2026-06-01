import { z } from 'zod';
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_AUTH_USER: z.string().optional(),
  APP_AUTH_PASS: z.string().optional(),
  GOSOM_URL: z.string().url().default('http://localhost:8080'),
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
