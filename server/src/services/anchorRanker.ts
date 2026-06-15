import type { DetectedSig, SignalMap } from '../db/premium';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from './visionClient';
import { getNumber } from './appSettings';

// Deterministic anchor selection. Ranks a lead's *assertable* evidence into an
// ordered candidate list. "Assertable" reuses the existing claim-gating thresholds
// (PSI < 50, ABSENT_VERIFIED signals, vision confidence ≥ 0.8 / ≥ 0.75, PRESENT
// signals) — no new thresholds are invented here. Raw-fetch gaps are intentionally
// excluded: they are UNKNOWN-grade and are the current husk source.

export type AnchorKind =
  | 'psi'
  | 'absent_verified'
  | 'vision_opportunity'
  | 'vision_strength'
  | 'present';

export interface AnchorCandidate {
  id: string;          // stable id, e.g. 'psi_mobile', 'absent_hasViewportMeta'
  kind: AnchorKind;
  fact: string;        // the verifiable fact, phrased in the lead's language
  evidenceRef: string; // machine-stable pointer into the evidence bundle
  priority: number;    // higher = stronger anchor
}

interface BusinessLite {
  category: string | null;
  locCountry: string | null;
}

// Reused thresholds — identical to geminiComposer's claim-gating; now live-tunable
// via the Settings tab (defaults: PSI 50, vision opp 0.75, vision strength 0.8).

// Human phrasing for known ABSENT_VERIFIED signal keys. Only hasViewportMeta is
// ABSENT_VERIFIED-eligible today (premiumAnalyzer); fallback covers future keys.
const ABSENT_PHRASE: Record<string, { ar: string; en: string }> = {
  hasViewportMeta: {
    ar: 'el sitio no parece estar optimizado para móviles',
    en: "the site doesn't appear mobile-optimized",
  },
};

export function rankAnchors(
  business: BusinessLite,
  detectedSigs?: DetectedSig[],
  psiData?: PsiData | null,
  visionResult?: VisionResult | null,
  signalMap?: SignalMap,
): AnchorCandidate[] {
  const isAR = business.locCountry === 'Argentina';
  const candidates: AnchorCandidate[] = [];

  // Live claim-gating thresholds (Settings tab; same defaults as before).
  const PSI_CRITICAL = getNumber('PSI_CRITICAL');
  const VISION_OPP_MIN = getNumber('VISION_OPP_MIN');
  const VISION_STRENGTH_MIN = getNumber('VISION_STRENGTH_MIN');

  // 1. PSI — real measured metric, most concrete and verifiable.
  if (psiData?.mobileScore !== null && psiData?.mobileScore !== undefined && psiData.mobileScore < PSI_CRITICAL) {
    const score = psiData.mobileScore;
    const hasLcp = psiData.lcp !== null && psiData.lcp !== undefined;
    const lcpSec = hasLcp ? (psiData.lcp as number / 1000).toFixed(1) : null;
    const fact = isAR
      ? `el sitio carga lento en móvil — puntuación ${score}/100 en Google PageSpeed${lcpSec ? ` (carga en ${lcpSec}s)` : ''}`
      : `the site loads slowly on mobile — ${score}/100 on Google PageSpeed${lcpSec ? ` (loads in ${lcpSec}s)` : ''}`;
    candidates.push({
      id: 'psi_mobile',
      kind: 'psi',
      fact,
      evidenceRef: `psi.mobileScore=${score}${hasLcp ? `;psi.lcp=${psiData.lcp}` : ''}`,
      priority: 100,
    });
  }

  // 2. ABSENT_VERIFIED signals — verified-absent by render + DOM + network + vision.
  if (signalMap) {
    for (const [key, sig] of Object.entries(signalMap)) {
      if (sig.state !== 'ABSENT_VERIFIED') continue;
      const phrase = ABSENT_PHRASE[key];
      const fact = phrase
        ? (isAR ? phrase.ar : phrase.en)
        : (isAR ? `el sitio no muestra ${key}` : `the site doesn't show ${key}`);
      candidates.push({
        id: `absent_${key}`,
        kind: 'absent_verified',
        fact,
        evidenceRef: `signal.${key}=ABSENT_VERIFIED`,
        priority: 80,
      });
    }
  }

  // 3. Vision opportunities — concrete weaknesses at confidence ≥ 0.75.
  // Guard headline: older stored vision_json rows may lack it.
  visionResult?.opportunities?.forEach((o, i) => {
    if (o.confidence < VISION_OPP_MIN || !o.headline) return;
    candidates.push({
      id: `vision_opp_${i}`,
      kind: 'vision_opportunity',
      fact: o.headline,
      evidenceRef: `vision.opportunities[${i}]=${o.headline}`,
      priority: 70 - i,
    });
  });

  // 4. Vision strengths — genuine compliments at confidence ≥ 0.8.
  visionResult?.strengths?.forEach((s, i) => {
    if (s.confidence < VISION_STRENGTH_MIN || !s.headline) return;
    candidates.push({
      id: `vision_str_${i}`,
      kind: 'vision_strength',
      fact: s.headline,
      evidenceRef: `vision.strengths[${i}]=${s.headline}`,
      priority: 60 - i,
    });
  });

  // 5. PRESENT signals (detected signatures) — assertable presence, weakest hook.
  detectedSigs?.forEach((d, i) => {
    candidates.push({
      id: `present_${d.id}`,
      kind: 'present',
      fact: isAR ? `usan ${d.name} en el sitio` : `the site uses ${d.name}`,
      evidenceRef: `detectedSig.${d.id}=${d.name}`,
      priority: 40 - i,
    });
  });

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}
