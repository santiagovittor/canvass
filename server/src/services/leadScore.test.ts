// Slice 0044 self-check. Plain node assert, no framework. Run:
//   docker exec maps-scraper-server-1 sh -c "cd /app/server && npx tsx src/services/leadScore.test.ts"
import assert from 'node:assert/strict';
import {
  establishmentScore, weightedRating, categoryFitScore, reachabilityScore,
  visiblePainScore, computeLeadScore, type LeadScoreInput,
} from './leadScore';

const approx = (a: number, b: number, eps = 0.01) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

// --- worked examples from the plan ---
approx(establishmentScore(0), 0);
approx(establishmentScore(49), 0.63);
approx(establishmentScore(500), 1);
approx(weightedRating(5, 2), 0.83);
approx(weightedRating(4.6, 400), 0.92);
approx(weightedRating(null, 999), 4.07 / 5); // null rating → prior
approx(categoryFitScore('Servicios legales'), 1.0);
approx(categoryFitScore('Agencia inmobiliaria'), 1.0);
approx(categoryFitScore('Peluquería'), 0.6);
approx(categoryFitScore('Ferretería'), 0.3);
approx(categoryFitScore(null), 0.3);

// --- monotonicity: more reviews ⇒ ≥ establishment ---
for (let n = 0; n < 600; n += 37)
  assert.ok(establishmentScore(n + 1) >= establishmentScore(n), `est not monotonic at ${n}`);

// --- F5: a 5.0 with 2 reviews must rank below a 4.6 with 400 (shrinkage works) ---
assert.ok(weightedRating(5, 2) < weightedRating(4.6, 400), 'F5: noisy 5.0 not shrunk below 4.6/400');

// --- reachability ordering (email lane): valid > unknown > unprobed(null) > invalid ---
const r = (v: Parameters<typeof reachabilityScore>[0]) => reachabilityScore(v, false, 'email');
assert.ok(r('valid') > r('unknown'), 'valid > unknown');
assert.ok(r('unknown') > r(null), 'unknown > unprobed');
assert.ok(r(null) > r('invalid'), 'unprobed > invalid');
// nosite lane = phone gate
assert.equal(reachabilityScore(null, true, 'nosite'), 1);
assert.equal(reachabilityScore('valid', false, 'nosite'), 0);

// --- visiblePain: lower PSI / more gaps ⇒ higher urgency; null PSI = neutral ---
approx(visiblePainScore(null, null), 0.4);
assert.ok(visiblePainScore(20, 4) > visiblePainScore(90, 0), 'slow+gappy more painful than fast+clean');

// --- graceful degradation: all-null input still yields a finite 0–1 score + grade ---
const empty: LeadScoreInput = {
  rating: null, reviewCount: null, category: null, emailValidity: null,
  hasPhone: false, psiMobile: null, gapCount: null,
};
const e = computeLeadScore(empty, 'email');
assert.ok(Number.isFinite(e.score) && e.score >= 0 && e.score <= 1, 'finite 0–1 score');
assert.ok(['A', 'B', 'C', 'D'].includes(e.grade), 'valid grade');

// --- determinism: same input twice ⇒ identical result ---
const inp: LeadScoreInput = {
  rating: 4.2, reviewCount: 680, category: 'Restaurante', emailValidity: 'valid',
  hasPhone: true, psiMobile: 55, gapCount: 2,
};
assert.deepEqual(computeLeadScore(inp, 'email'), computeLeadScore(inp, 'email'), 'non-deterministic');

// --- manual table: a 680-review 4.2 restaurant outranks a 2-review 5.0 (nosite, both have phone) ---
const established: LeadScoreInput = {
  rating: 4.2, reviewCount: 680, category: 'Restaurante', emailValidity: null,
  hasPhone: true, psiMobile: null, gapCount: null,
};
const fresh: LeadScoreInput = { ...established, rating: 5, reviewCount: 2 };
assert.ok(
  computeLeadScore(established, 'nosite').score > computeLeadScore(fresh, 'nosite').score,
  '680/4.2 should outrank 2/5.0',
);

// --- phone gate zeroes a phoneless nosite lead out of the queue ---
assert.equal(computeLeadScore({ ...established, hasPhone: false }, 'nosite').score, 0, 'phoneless nosite not zeroed');

// --- slice 0050: advertisingIntent is boost-only on the email lane ---
const baseLead: LeadScoreInput = {
  rating: 4.4, reviewCount: 120, category: 'Restaurante', emailValidity: 'unknown',
  hasPhone: true, psiMobile: 60, gapCount: 1,
};
const nonAd = computeLeadScore(baseLead, 'email');
const ad = computeLeadScore({ ...baseLead, advertisingIntent: true }, 'email');
// undefined advertisingIntent === false === neutral: identical to omitting the field
assert.deepEqual(computeLeadScore({ ...baseLead, advertisingIntent: false }, 'email'), nonAd, 'false advertisingIntent must be neutral');
approx(ad.score, nonAd.score + 0.10);          // exactly the boost (pre-clamp here, score < 0.9)
assert.ok(ad.score >= nonAd.score, 'advertiser never scores below non-advertiser');
assert.equal(ad.components.advertisingIntent, 0.10, 'advertiser component is the boost');
assert.equal(nonAd.components.advertisingIntent, 0, 'non-advertiser component is 0, not negative');
assert.ok('DCBA'.indexOf(ad.grade) >= 'DCBA'.indexOf(nonAd.grade), 'advertiser grade is never lower'); // A best
// boost is capped by clamp01 — a near-perfect lead can't exceed 1.0
const top: LeadScoreInput = {
  rating: 4.9, reviewCount: 800, category: 'Servicios legales', emailValidity: 'valid',
  hasPhone: true, psiMobile: 5, gapCount: 4, advertisingIntent: true,
};
assert.ok(computeLeadScore(top, 'email').score <= 1, 'boost stays clamped at 1.0');

console.log('leadScore.test.ts: all asserts passed');
