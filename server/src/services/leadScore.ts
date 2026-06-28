// Slice 0044: deterministic lead-scoring primitives. Pure math, NO side effects —
// no db/Drizzle, no fetch, no Date.now. Same input ⇒ same score, always (the queue
// order must be stable + explainable). Consumed on read by getOutreachLeads (0045,
// email lane) and getNoSiteLeads (0048, nosite lane); neither reimplements the math.
// Traces to diagnosis 0043 F1 (no scoring exists) + F5 (rating noisy alone).
//
// EmailValidity is a TYPE-only import — erased at compile, so this stays a pure
// module despite living server-side (constraint: needs the EmailValidity type).
import type { EmailValidity } from '../db';

export type Lane = 'email' | 'nosite';

export interface LeadScoreInput {
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  emailValidity: EmailValidity | null; // null = unprobed (0046 hasn't run)
  hasPhone: boolean;
  psiMobile: number | null;            // null = no PSI yet (0049 hasn't run)
  gapCount: number | null;             // buildAnalysisGaps().count, null = no analysis
  advertisingIntent?: boolean;         // slice 0050: site runs ad pixels (Meta/Google Ads). undefined/false = neutral
}

export type Grade = 'A' | 'B' | 'C' | 'D';

export interface LeadScoreResult {
  score: number; // 0–1
  grade: Grade;
  components: Record<string, number>;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Slice 0050: boost-only additive term for a lead whose site runs paid-acquisition
// pixels (Meta Pixel / Google Ads conversion). A business already paying to acquire
// customers is the highest-intent buyer of marketing/AI services (0043 F8). Modest +
// (never negative — a non-advertiser is NOT penalized, only an advertiser lifted).
const AD_INTENT_BOOST = 0.10;

// log-scaled: 0 reviews → 0, ~500+ → 1. A 500-review business is "established".
export function establishmentScore(reviewCount: number | null): number {
  return clamp01(Math.log10((reviewCount ?? 0) + 1) / Math.log10(500));
}

// Bayesian shrinkage toward the real DB mean (0043 §b) so a 5.0 with 2 reviews
// can't outrank a 4.6 with 400. Kills the 720 low-n 5.0s (F5). Returns prior/5
// when rating is unknown.
const RATING_PRIOR_C = 4.07;
const RATING_WEIGHT_M = 20;
export function weightedRating(rating: number | null, reviewCount: number | null): number {
  const n = reviewCount ?? 0;
  if (rating === null) return RATING_PRIOR_C / 5;
  return ((RATING_WEIGHT_M * RATING_PRIOR_C + n * rating) / (RATING_WEIGHT_M + n)) / 5;
}

// Case-insensitive stem match against the real DB category strings (0043 §a/f):
// legal/dental/medical/real-estate are the top automation-fit tier; bookable
// services mid; everything else baseline.
const TOP_TIER_CATS = /abogad|bufete|legal|jur[ií]dic|dentist|dental|odont|m[eé]dic|cl[ií]nic|salud|real estate|inmobiliar/i;
const BOOKABLE_CATS = /peluquer|veterinari|gimnas|restaur|est[eé]tic|caf[eé]|\bbar\b|hotel/i;
export function categoryFitScore(category: string | null): number {
  const c = (category ?? '').trim();
  if (!c) return 0.3;
  if (TOP_TIER_CATS.test(c)) return 1.0;
  if (BOOKABLE_CATS.test(c)) return 0.6;
  return 0.3;
}

// email lane keys off email deliverability; nosite lane has no email, so a phone is
// the only contact channel → hard 0/1 gate.
export function reachabilityScore(
  emailValidity: EmailValidity | null,
  hasPhone: boolean,
  lane: Lane,
): number {
  if (lane === 'nosite') return hasPhone ? 1.0 : 0.0;
  switch (emailValidity) {
    case 'valid': return 1.0;
    case 'unknown': return 0.5;
    case 'invalid': return 0.0;
    default: return 0.4; // null = unprobed
  }
}

// Visible site pain: low PSI + many analysis gaps ⇒ higher urgency (the lead has a
// concrete problem to pitch). No PSI yet ⇒ neutral 0.4 (don't punish unanalyzed).
export function visiblePainScore(psiMobile: number | null, gapCount: number | null): number {
  if (psiMobile === null) return 0.4;
  return 0.6 * clamp01((100 - psiMobile) / 100) + 0.4 * clamp01((gapCount ?? 0) / 4);
}

// Display-only cutoffs (0043 open-q 4: show the grade). A ≥ 0.75 / B ≥ 0.55 /
// C ≥ 0.35 / D < 0.35.
function toGrade(score: number): Grade {
  if (score >= 0.75) return 'A';
  if (score >= 0.55) return 'B';
  if (score >= 0.35) return 'C';
  return 'D';
}

// ponytail: weights + category map are the calibration knob — retune from real
// reply data once 0039 analytics has enough sends.
export function computeLeadScore(input: LeadScoreInput, lane: Lane): LeadScoreResult {
  const establishment = establishmentScore(input.reviewCount);
  const rating = weightedRating(input.rating, input.reviewCount);
  const categoryFit = categoryFitScore(input.category);
  const reachability = reachabilityScore(input.emailValidity, input.hasPhone, lane);
  const visiblePain = visiblePainScore(input.psiMobile, input.gapCount);

  let score: number;
  let components: Record<string, number>;

  if (lane === 'email') {
    const advertisingIntent = input.advertisingIntent ? AD_INTENT_BOOST : 0;
    score = reachability * 0.40 + visiblePain * 0.20 + establishment * 0.20 + categoryFit * 0.20 + advertisingIntent;
    components = { reachability, visiblePain, establishment, categoryFit, advertisingIntent };
  } else {
    // establishment-led; reachability is a 0/1 phone gate that zeroes phoneless leads
    // out of the queue entirely.
    const base = establishment * 0.45 + rating * 0.30 + categoryFit * 0.25;
    score = base * reachability;
    components = { establishment, weightedRating: rating, categoryFit, reachability };
  }

  score = clamp01(score);
  return { score, grade: toGrade(score), components };
}
