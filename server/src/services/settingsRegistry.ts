import { z } from 'zod';
import { env } from '../env';
import { GMAIL_HARD_CEILING } from './outreachConstants';

// Single source of truth for the live-tunable config surface. One array of field
// defs drives BOTH server validation AND the auto-rendered client form, so the two
// can never drift. The accessor (appSettings.ts) resolves a value as
// code-default < env (if envVar set) < db override, then clamps numerics to [min,max].
//
// This module imports only `env`, raw literals, and the dependency-free constants
// leaf — never outreachSchedulingConfig — so it stays free of the config↔accessor
// import cycle. The cap's max is the single-sourced GMAIL_HARD_CEILING backstop.

export type SettingType =
  | 'number' | 'string' | 'enum' | 'boolean'
  | 'time'      // 'HH:MM' BA wall-clock
  | 'weekdays'  // number[] of 0=Sun..6=Sat
  | 'signature' // file-backed HTML blob
  | 'secret';   // read-only masked status; never persisted, never returned plaintext

export type SettingValue = number | string | boolean | number[];

export interface SettingField {
  key: string;
  group: string;
  label: string;
  type: SettingType;
  unit?: string;
  min?: number;
  max?: number;
  enum?: string[];
  default: SettingValue;   // code literal baseline (byte-identical to today)
  envVar?: keyof typeof env;
  isSecret?: boolean;
  fileBacked?: boolean;
  help?: string;
}

// Single-sourced from the constants leaf (not a literal) so the write-reject gate
// tracks the same ceiling the governor clamps to. The accessor also clamps to it.
const HARD_CEILING = GMAIL_HARD_CEILING;

export const GROUPS = [
  'Sending & Deliverability',
  'Analysis & Claim-Gating',
  'Gemini & Rate Limits',
  'Batch & Automation',
  'Offer & Copy',
  'Secrets',
] as const;

export const FIELDS: SettingField[] = [
  // ── Sending & Deliverability ──
  {
    key: 'OUTREACH_DAILY_CAP', group: 'Sending & Deliverability', label: 'Daily send cap (rolling 24h)',
    type: 'number', unit: 'emails', min: 1, max: HARD_CEILING, default: 15, envVar: 'OUTREACH_DAILY_CAP',
    help: `Hard-ceiling backstop is ${HARD_CEILING}; values above it are clamped.`,
  },
  {
    key: 'PACING_MIN_MS', group: 'Sending & Deliverability', label: 'Min inter-send gap',
    type: 'number', unit: 'ms', min: 0, max: 86_400_000, default: 5 * 60_000,
  },
  {
    key: 'PACING_MAX_MS', group: 'Sending & Deliverability', label: 'Max inter-send gap',
    type: 'number', unit: 'ms', min: 0, max: 86_400_000, default: 15 * 60_000,
  },
  {
    key: 'GENERIC_WINDOW_START', group: 'Sending & Deliverability', label: 'Generic window start (BA)',
    type: 'time', default: '09:00',
  },
  {
    key: 'GENERIC_WINDOW_END', group: 'Sending & Deliverability', label: 'Generic window end (BA)',
    type: 'time', default: '18:00',
  },
  {
    key: 'GENERIC_WINDOW_DAYS', group: 'Sending & Deliverability', label: 'Generic window weekdays',
    type: 'weekdays', default: [1, 2, 3, 4, 5],
  },

  // ── Analysis & Claim-Gating ──
  {
    key: 'PSI_CRITICAL', group: 'Analysis & Claim-Gating', label: 'PSI critical threshold',
    type: 'number', unit: '/100', min: 0, max: 100, default: 50,
    help: 'Mobile PageSpeed below this is an assertable slow-site anchor.',
  },
  {
    key: 'VISION_OPP_MIN', group: 'Analysis & Claim-Gating', label: 'Vision opportunity min confidence',
    type: 'number', min: 0, max: 1, default: 0.75,
  },
  {
    key: 'VISION_STRENGTH_MIN', group: 'Analysis & Claim-Gating', label: 'Vision strength min confidence',
    type: 'number', min: 0, max: 1, default: 0.8,
  },
  {
    key: 'MAX_ANCHOR_ATTEMPTS', group: 'Analysis & Claim-Gating', label: 'Max anchor attempts',
    type: 'number', min: 1, max: 10, default: 2,
  },
  {
    key: 'VERIFIER_SKIP_TRUSTED_ANCHORS', group: 'Analysis & Claim-Gating', label: 'Skip verifier for trusted anchors',
    type: 'boolean', default: false,
    help: 'When ON, skips the Gemini fact-check for leads whose anchor is a deterministic detector (PSI score, ABSENT_VERIFIED signal, or Meta-Pixel+no-assistant) AND whose draft declares only that one anchor claim. Saves 1+ Gemini call per such lead. Tradeoff: the verifier’s undeclared-claim body scan is skipped, so a hallucinated extra website claim could ship unflagged. Default OFF.',
  },
  {
    key: 'META_PIXEL_ANCHOR_ENABLED', group: 'Analysis & Claim-Gating', label: 'Meta Pixel no-assistant anchor',
    type: 'boolean', default: true,
    help: 'When enabled, Meta Pixel plus verified no assistant can become a high-priority outreach anchor.',
  },
  {
    key: 'META_PIXEL_ANCHOR_PRIORITY', group: 'Analysis & Claim-Gating', label: 'Meta Pixel anchor priority',
    type: 'number', min: 0, max: 200, default: 90,
    help: 'Priority for the compound Meta Pixel plus no-assistant anchor.',
  },
  {
    key: 'ASSISTANT_ANCHOR_ENABLED', group: 'Analysis & Claim-Gating', label: 'No-assistant anchor (standalone)',
    type: 'boolean', default: true,
    help: 'When enabled, a verified-absent chat/assistant widget (without a Meta Pixel) can become an outreach anchor. Claim stays narrow — no ads/spend framing.',
  },
  {
    key: 'ASSISTANT_ANCHOR_PRIORITY', group: 'Analysis & Claim-Gating', label: 'No-assistant anchor priority',
    type: 'number', min: 0, max: 200, default: 85,
    help: 'Priority for the standalone no-assistant anchor. Keep below the Meta Pixel anchor so the compound anchor wins when both apply.',
  },

  // ── Gemini & Rate Limits ──
  {
    key: 'GEMINI_MODEL', group: 'Gemini & Rate Limits', label: 'Gemini model (compose)',
    type: 'string', default: 'gemini-2.5-flash',
  },
  {
    key: 'GEMINI_VERIFIER_MODEL', group: 'Gemini & Rate Limits', label: 'Gemini model (verify)',
    type: 'string', default: 'gemini-2.5-flash',
    help: 'Must stay a SEPARATE model from the composer. 2.5-flash is cheaper and currently more reliable than 3.5-flash for the fact-check pass.',
  },
  {
    key: 'REUSE_ANALYSIS_TTL_DAYS',
    group: 'Gemini & Rate Limits',
    label: 'Analysis reuse TTL (days)',
    type: 'number',
    unit: 'days',
    min: 0,
    max: 365,
    default: 14,
    help: 'Skip re-running premium analysis if a completed run exists within this many days. 0 = always re-run.',
  },
  {
    key: 'GEMINI_COMPOSER_FALLBACK_MODEL',
    group: 'Gemini & Rate Limits',
    label: 'Gemini model (compose fallback)',
    type: 'string',
    default: 'gemini-2.5-flash-lite',
    envVar: 'GEMINI_COMPOSER_FALLBACK_MODEL',
    help: 'Used once if the primary compose model returns 5xx after all retries. Must differ from GEMINI_MODEL to avoid a no-op fallback. Use a real, reliable model — NOT gemini-3-flash (404, not a valid id) or gemini-3.5-flash (chronic 503s).',
  },
  {
    key: 'COMPOSE_503_QUARANTINE_MINUTES',
    group: 'Gemini & Rate Limits',
    label: 'Composer primary 5xx quarantine (minutes)',
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 120,
    default: 10,
    help: 'After 2 consecutive 5xx from the primary compose model within 5 minutes, skip it and route directly to the fallback for this many minutes. 0 = disabled.',
  },
  {
    key: 'GEMINI_RPM', group: 'Gemini & Rate Limits', label: 'Gemini requests/min',
    type: 'number', unit: 'rpm', min: 1, max: 10_000, default: 120, envVar: 'GEMINI_RPM',
    help: 'Tuned to Tier-1 headroom for fast generation. minTime spacing = 60000/RPM ms between calls.',
  },
  {
    key: 'GEMINI_RPD', group: 'Gemini & Rate Limits', label: 'Gemini requests/day',
    type: 'number', unit: 'rpd', min: 1, max: 10_000_000, default: 1000, envVar: 'GEMINI_RPD',
  },
  {
    key: 'GEMINI_MAX_CONCURRENT', group: 'Gemini & Rate Limits', label: 'Gemini max concurrent calls',
    type: 'number', min: 1, max: 8, default: 1,
    help: 'Keep at 1 to serialize vision image calls so one analysis can’t burst. Raise only for batch throughput.',
  },
  {
    key: 'GEMINI_TIMEOUT_MS', group: 'Gemini & Rate Limits', label: 'Per-call hard timeout (compose/verify)',
    type: 'number', unit: 'ms', min: 5_000, max: 120_000, default: 30_000,
    help: 'Each generateContent call is aborted past this. Fail fast, then retry within the total cap — nothing hangs for minutes.',
  },
  {
    key: 'GEMINI_VISION_TIMEOUT_MS', group: 'Gemini & Rate Limits', label: 'Per-call hard timeout (vision)',
    type: 'number', unit: 'ms', min: 5_000, max: 120_000, default: 40_000,
    help: 'Vision calls carry screenshots and run slower; given a longer per-call ceiling than text calls.',
  },
  {
    key: 'GEMINI_TOTAL_CAP_MS', group: 'Gemini & Rate Limits', label: 'Total wall-clock cap per call',
    type: 'number', unit: 'ms', min: 10_000, max: 300_000, default: 90_000,
    help: 'Hard ceiling on a single logical call across all retries (honors server retryDelay but bounded). Past this, fail safe.',
  },

  // ── Batch & Automation ──
  {
    key: 'SCHEDULER_PAUSED', group: 'Batch & Automation', label: 'Pause scheduler',
    type: 'boolean', default: false,
    help: 'When enabled, the scheduler ticks but claims no new rows. In-flight claimed rows finish naturally.',
  },
  {
    key: 'SCRAPE_SCHEDULES_PAUSED', group: 'Batch & Automation', label: 'Pause scrape scheduler',
    type: 'boolean', default: false,
    help: 'When enabled, the scrape scheduler ticks but claims no new schedules. In-flight runs finish naturally.',
  },
  {
    key: 'AUTO_ANALYZE_PAUSED', group: 'Batch & Automation', label: 'Pause auto-analyze',
    type: 'boolean', default: false,
    help: 'When enabled, the auto-analyze worker claims no new leads; in-flight analysis finishes and new scrapes still enqueue pending rows that drain on resume. Independent of the scrape scheduler.',
  },
  {
    key: 'BATCH_PREPARE_CONCURRENCY', group: 'Batch & Automation', label: 'Batch prepare concurrency',
    type: 'number', min: 1, max: 32, default: 3, envVar: 'BATCH_PREPARE_CONCURRENCY',
  },
  {
    key: 'BATCH_ANALYZE_TIMEOUT_MS', group: 'Batch & Automation', label: 'Per-item analyze timeout',
    type: 'number', unit: 'ms', min: 1000, max: 600_000, default: 120_000, envVar: 'BATCH_ANALYZE_TIMEOUT_MS',
  },
  {
    key: 'BATCH_COMPOSE_TIMEOUT_MS', group: 'Batch & Automation', label: 'Per-item compose timeout',
    type: 'number', unit: 'ms', min: 1000, max: 600_000, default: 180_000, envVar: 'BATCH_COMPOSE_TIMEOUT_MS',
    help: 'A stuck compose (Gemini call that never returns) fails the lead at this bound; the batch continues. Above worst-case-legit, well under "stuck".',
  },
  {
    key: 'BATCH_STALL_TIMEOUT_MS', group: 'Batch & Automation', label: 'Run-level stall timeout',
    type: 'number', unit: 'ms', min: 30_000, max: 3_600_000, default: 600_000, envVar: 'BATCH_STALL_TIMEOUT_MS',
    help: 'A running batch making no progress for this long is finalized: its non-terminal items fail (stalled). Keep above one slow item (analyze+compose ≈ 300s).',
  },

  // ── Offer & Copy ──
  {
    key: 'EMAIL_SIGNATURE_HTML', group: 'Offer & Copy', label: 'Email signature (HTML)',
    type: 'signature', default: '', fileBacked: true,
    help: 'Appended at send time, after compose + verify. Saved to the signature file and reloaded live.',
  },
  {
    key: 'ASSISTANT_OFFER_ES', group: 'Offer & Copy', label: 'Assistant offer copy (ES)',
    type: 'string',
    default: 'También diseño asistentes virtuales con IA: chatbots que responden las consultas de los visitantes al instante, las 24 horas, y registran cada mensaje para que usted lo retome cuando pueda.',
    help: 'Service statement (always true). Woven in as a benefit. Asserting the lead LACKS one is gated separately by the anchor.',
  },
  {
    key: 'ASSISTANT_OFFER_EN', group: 'Offer & Copy', label: 'Assistant offer copy (EN)',
    type: 'string',
    default: 'I also design AI virtual assistants — chatbots that answer visitor questions instantly, 24/7, and log every message so you can follow up when you have a moment.',
    help: 'Service statement (always true). Woven in as a benefit. Asserting the lead LACKS one is gated separately by the anchor.',
  },
  {
    key: 'SITE_TONE_DIRECTIVE_ES', group: 'Offer & Copy', label: 'Site-observation tone directive (ES)',
    type: 'string',
    default: 'TONO DE LAS OBSERVACIONES DEL SITIO: toda observación sobre el sitio y su consecuencia se redacta como un aviso de buena fe, nunca como un veredicto. Usá modales suaves (puede, podría, suele, es posible que) en la consecuencia. Ejemplo: "puede provocar que las visitas se retiren", no "provoca que las visitas se retiren". Esto aplica sólo a las observaciones del sitio; la oferta sigue siendo directa.',
    help: 'Injected into the Spanish composer prompt. Governs the hedged advisory register for site observations.',
  },
  {
    key: 'SITE_TONE_DIRECTIVE_EN', group: 'Offer & Copy', label: 'Site-observation tone directive (EN)',
    type: 'string',
    default: 'TONE FOR SITE OBSERVATIONS: every observation about the site and its consequence is a good-faith heads-up, never a verdict. Use soft modals (may, might, often, tends to) on the consequence. Example: "may cause visitors to leave", not "causes visitors to leave". This applies only to site observations; the offer stays direct.',
    help: 'Injected into the English composer prompt. Governs the hedged advisory register for site observations.',
  },

  // ── Secrets (read-only masked status) ──
  {
    key: 'GMAIL_APP_PASSWORD', group: 'Secrets', label: 'Gmail app password',
    type: 'secret', default: '', envVar: 'GMAIL_APP_PASSWORD', isSecret: true,
  },
  {
    key: 'GEMINI_API_KEY', group: 'Secrets', label: 'Gemini API key',
    type: 'secret', default: '', envVar: 'GEMINI_API_KEY', isSecret: true,
  },
  {
    key: 'PAGESPEED_API_KEY', group: 'Secrets', label: 'PageSpeed API key',
    type: 'secret', default: '', envVar: 'PAGESPEED_API_KEY', isSecret: true,
  },
];

const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));
export function getField(key: string): SettingField | undefined {
  return FIELD_BY_KEY.get(key);
}

// Per-key zod validator built from type + min/max/enum. Used on every write path.
export function validatorFor(field: SettingField): z.ZodTypeAny {
  switch (field.type) {
    case 'number': {
      let s = z.number();
      if (field.min !== undefined) s = s.min(field.min);
      if (field.max !== undefined) s = s.max(field.max);
      return s;
    }
    case 'string':
    case 'signature':
      return z.string();
    case 'enum':
      return z.enum((field.enum ?? ['']) as [string, ...string[]]);
    case 'boolean':
      return z.boolean();
    case 'time':
      return z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');
    case 'weekdays':
      return z.array(z.number().int().min(0).max(6)).min(1).max(7);
    case 'secret':
      // Secrets are never written through the settings path.
      return z.never();
  }
}
