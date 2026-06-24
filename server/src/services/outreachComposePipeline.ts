import type { WebsiteAnalysis } from './websiteAnalyzer';
import { composeEmail, type BusinessForEmail } from './geminiComposer';
import { rankAnchors } from './anchorRanker';
import { verifyDraft, type VerificationBundle, type VerificationResult, type VerificationAttempt } from './geminiVerifier';
import type { DetectedSig, SignalMap } from '../db/premium';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from './visionClient';
import { getNumber, getBool } from './appSettings';
import { withAnalysis, stage, stageCached, setSummary } from './stageTracker';

// Anchor kinds grounded in deterministic detectors (not free LLM text). Eligible for
// the opt-in verifier skip: a PSI number, a 4-detector ABSENT_VERIFIED, or the
// Meta-Pixel + verified-no-assistant compound — all machine-checked, not asserted.
const TRUSTED_ANCHOR_KINDS = new Set(['psi', 'absent_verified', 'meta_pixel_no_assistant']);

// Bounded anchor attempts. Assertable candidates rarely exceed ~3 strong ones
// (PSI + one vision + one absent_verified); each attempt costs 1 compose + up to
// 3 verify calls, so 3 bounds worst-case ~12 Gemini calls and keeps latency sane.
// Live-tunable via the Settings tab; default 3.

// Fuzzy claim matching: the verifier may re-quote a declared claim with minor
// punctuation/whitespace differences. Normalize and check containment both ways.
function normClaim(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function claimsMatch(a: string, b: string): boolean {
  const na = normClaim(a);
  const nb = normClaim(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

export interface ComposeVerifiedResult {
  subject: string;
  body: string;
  topGap: string | null;
  verdict: VerificationResult;
}

// Single source of truth for the compose → verify → repair → specificity-guard
// loop. Returns the final draft + verdict WITHOUT persisting — the caller decides
// what to store. Guarantees: a 'sent_specific' disposition always carries a
// supported, prospect-specific anchor claim still present in the body; otherwise
// the result is 'held_generic' (a fail-closed status the /send gate rejects).
export async function composeVerifiedEmail(
  business: BusinessForEmail,
  analysis: WebsiteAnalysis | undefined,
  detectedSigs: DetectedSig[] | undefined,
  psiData: PsiData | null,
  visionResult: VisionResult | null,
  signalMap: SignalMap | undefined,
  businessId?: string,
): Promise<ComposeVerifiedResult> {
  const run = () => composeVerifiedEmailInner(business, analysis, detectedSigs, psiData, visionResult, signalMap);
  // businessId present → emit the stage-event stream (logs + SSE) keyed to the lead.
  return businessId ? withAnalysis(businessId, 'compose', run) : run();
}

async function composeVerifiedEmailInner(
  business: BusinessForEmail,
  analysis: WebsiteAnalysis | undefined,
  detectedSigs: DetectedSig[] | undefined,
  psiData: PsiData | null,
  visionResult: VisionResult | null,
  signalMap: SignalMap | undefined,
): Promise<ComposeVerifiedResult> {
  const bundle: VerificationBundle = { signals: signalMap, vision: visionResult, psi: psiData };
  const candidates = rankAnchors(business, detectedSigs, psiData, visionResult, signalMap);

  // No assertable evidence to anchor on → hold, never auto-send a generic husk.
  if (candidates.length === 0) {
    setSummary({ disposition: 'held_generic' });
    return {
      subject: '', body: '', topGap: null,
      verdict: {
        status: 'held_generic',
        claims: [],
        error: 'No assertable evidence available to anchor a specific observation.',
        attempts: [],
        disposition: 'held_generic',
      },
    };
  }

  const attempts: VerificationAttempt[] = [];
  const maxAttempts = Math.min(candidates.length, getNumber('MAX_ANCHOR_ATTEMPTS'));

  for (let i = 0; i < maxAttempts; i++) {
    const anchor = candidates[i];
    const composed = await stage('compose', () => composeEmail(business, anchor, analysis, undefined, detectedSigs, psiData, visionResult, signalMap));
    const declaredAnchor = composed.claims.find(c => c.evidenceRef === anchor.evidenceRef);

    const subject = composed.subject;
    let body = composed.body;

    // Opt-in verifier skip (default off): a deterministic anchor whose draft declares
    // ONLY that one anchor claim has nothing for the fact-check to grade — synthesize an
    // ok verdict and save the verify call. Any secondary declared claim ⇒ verify runs.
    const canSkipVerify =
      getBool('VERIFIER_SKIP_TRUSTED_ANCHORS') &&
      TRUSTED_ANCHOR_KINDS.has(anchor.kind) &&
      composed.claims.length === 1 &&
      !!declaredAnchor;

    let verdict: VerificationResult;
    if (canSkipVerify) {
      stageCached('verify');
      verdict = {
        status: 'ok',
        claims: [{ claim: declaredAnchor!.text, supported: true, evidence: `trusted-anchor-skip: ${anchor.evidenceRef}` }],
      };
    } else {
      verdict = await stage('verify', () => verifyDraft({ subject, body }, composed.claims, bundle));
    }

    // Specificity guard: the anchor's declared claim must survive as supported.
    const anchorSurvived = (v: VerificationResult): boolean =>
      !!declaredAnchor && v.claims.some(c => c.supported && claimsMatch(c.claim, declaredAnchor.text));

    let status: VerificationResult['status'] = verdict.status;

    if (verdict.status === 'violations' && anchorSurvived(verdict)) {
      // Anchor is fine; strip only the secondary (non-anchor) unsupported sentences.
      const unsupported = verdict.claims.filter(
        c => !c.supported && !(declaredAnchor && claimsMatch(c.claim, declaredAnchor.text)),
      );
      let strippedBody = body;
      for (const c of unsupported) {
        const escaped = c.claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        strippedBody = strippedBody.replace(new RegExp(`[^.!?]*${escaped}[^.!?]*[.!?]?\\s*`, 'g'), '').trim();
      }
      const verdict3 = await stage('verify', () => verifyDraft({ subject, body: strippedBody }, composed.claims, bundle));
      if (verdict3.status === 'ok' && anchorSurvived(verdict3)) {
        body = strippedBody;
        verdict = verdict3;
        status = 'violations_stripped';
      } else {
        verdict = verdict3;
        status = verdict3.status;
      }
    }

    const survived = (status === 'ok' || status === 'violations_stripped') && anchorSurvived(verdict);
    attempts.push({ anchorId: anchor.id, status, survived });

    if (survived) {
      await stage('gate', async () => { /* disposition decision: send-specific */ });
      setSummary({ anchor: anchor.id, disposition: 'sent_specific' });
      return {
        subject, body, topGap: composed.topGap,
        verdict: { ...verdict, status, anchorId: anchor.id, anchorFact: anchor.fact, attempts, disposition: 'sent_specific' },
      };
    }
    // Anchor did not survive — try the next candidate.
  }

  // No candidate produced a surviving specific anchor → hold generic.
  await stage('gate', async () => { /* disposition decision: hold generic */ });
  const last = candidates[maxAttempts - 1];
  setSummary({ anchor: last?.id ?? null, disposition: 'held_generic' });
  return {
    subject: '', body: '', topGap: null,
    verdict: {
      status: 'held_generic',
      claims: [],
      error: 'No anchor survived verification — would send generic. Held.',
      anchorId: last?.id,
      anchorFact: last?.fact,
      attempts,
      disposition: 'held_generic',
    },
  };
}
