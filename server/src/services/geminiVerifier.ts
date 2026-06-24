import { SchemaType } from '@google/generative-ai';
import { withGeminiRate, GeminiRpdExhausted, describeGeminiError } from './geminiRateLimiter';
import { makeGenerate } from './aiProvider';
import { createQuarantine } from './modelQuarantine';
import type { ResponseSchema } from '@google/generative-ai';
import type { SignalMap } from '../db/premium';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from './visionClient';
import type { ComposedClaim } from './geminiComposer';
import { getString, getNumber } from './appSettings';

export interface VerificationBundle {
  signals?: SignalMap;
  vision?: VisionResult | null;
  psi?: PsiData | null;
}

export interface ClaimVerdict {
  claim: string;
  supported: boolean;
  evidence: string;
}

// All statuses that can appear in verification_json.
// The /send allowlist is opt-in — add new statuses here, then decide at the gate.
export type VerificationStatus =
  | 'ok'                  // all claims supported, safe to send
  | 'violations'          // transient — not stored as final status
  | 'violations_stripped' // offending sentences stripped + re-verified ok
  | 'held'                // could not resolve violations — must not auto-send
  | 'held_generic'        // no prospect-specific claim survived — must not auto-send
  | 'verifier_failed'     // verifier threw/returned malformed JSON — must not auto-send
  | 'override_sent';      // human overrode a held/failed verdict via ?override=true

export interface VerificationAttempt {
  anchorId: string;
  status: VerificationStatus;
  survived: boolean;
}

export interface VerificationResult {
  status: VerificationStatus;
  claims: ClaimVerdict[];
  error?: string;
  overrideAt?: string;        // ISO timestamp, present only on override_sent
  overriddenStatus?: string;  // original status before override
  // Additive specificity-guard audit (stored in the same verification_json).
  anchorId?: string;
  anchorFact?: string;
  attempts?: VerificationAttempt[];
  disposition?: 'sent_specific' | 'held_generic';
}

// Statuses the /send route allows through without a manual override.
export const SEND_ALLOWED_STATUSES: VerificationStatus[] = ['ok', 'violations_stripped'];

const SYSTEM_VERIFIER = `You are a fact-checker for cold email drafts about websites. A developer wrote an email making claims about a business's website. You receive: the draft email, the composer's DECLARED claims (each with an evidenceRef pointing into the evidence bundle), and an evidence bundle (signal states, vision analysis, PageSpeed metrics).

Your job has TWO parts:
A) Grade every DECLARED claim: is it supported by the provided evidence?
B) Scan the draft body for any factual WEBSITE claim that is NOT in the declared list. Each such undeclared website claim is a VIOLATION — report it with supported=false and evidence "undeclared: not in declared claims". This prevents the email from asserting facts the composer never grounded.

## Rules for "supported"

A claim containing multiple assertions is supported ONLY if EVERY assertion in it is independently supported; if any part fails, supported=false.

**Hedged phrasing** ("no encontré... a primera vista", "I couldn't find...", "no parece...", "doesn't seem to") is supported ONLY if the relevant signal is ABSENT_VERIFIED or UNKNOWN in the evidence bundle. If the evidence contradicts the hedge (e.g., vision.strengths contains that feature at high confidence), the hedge is UNSUPPORTED. Hedged phrasing is necessary but not sufficient.

**Flat negatives** ("no tiene X", "carece de X", "doesn't have X", "lacks X") are UNSUPPORTED unless the signal state is ABSENT_VERIFIED with evidence.

**Flat positives** ("tiene buena velocidad", "has fast loading", "shows X clearly", "usan Calendly") are supported only if vision.strengths or PSI metrics back the claim, OR the relevant signal state is PRESENT in the bundle (a detected signature / PRESENT signal counts as evidence of presence).

**PSI numbers**: a specific score claim is supported if psi.mobileScore in the bundle matches within ±1. A directional claim ("slow performance", "bajo rendimiento", "carga lento") is supported if score < 50.

**Vision strengths**: a claim is supported if vision.strengths contains a matching observation with confidence ≥ 0.8. **Vision opportunities**: a claim is supported if vision.opportunities contains a matching observation with confidence ≥ 0.75.

**UNKNOWN signals**: any claim about that feature — positive, negative, or hedged — is UNSUPPORTED.

**Non-website claims** (the sender's name, the CTA, the greeting, compliments about the business itself) are not factual website claims — skip them entirely in part B and do not report them.

**Service / offer statements** about what the SENDER provides ("I also design AI assistants", "también diseño asistentes virtuales con IA", "I build websites") are always-true service statements, NOT claims about the lead's site — skip them in part B, do not grade them. BUT any assertion that the LEAD lacks/has no a feature ("you have no assistant", "no tienen un asistente", "the site doesn't have a chatbot", "parece no tener un asistente") IS a website claim and is graded against the signal state: supported ONLY if that signal is ABSENT_VERIFIED with evidence (e.g. hasLiveChatWidget=ABSENT_VERIFIED). Do not let an offer launder an unsupported absence claim.

**Hedged advisory consequences** — a soft prediction of outcome attached to an observation ("puede provocar que las visitas se retiren", "suele hacer que…", "may cause visitors to leave", "tends to make…") is an advisory opinion, NOT a standalone factual website claim. Do not report it as an undeclared violation, provided the observation it attaches to is itself supported. Grade the observation, not the predicted consequence.

## Output

Return ONLY valid JSON, no other text. Include one entry per declared claim (graded), plus one entry per undeclared website claim found in the body:
{"claims":[{"claim":"<exact short quote from the email>","supported":<bool>,"evidence":"<what evidence you relied on, or what contradicts the claim>"}]}

If the body makes no factual website claims and none were declared, return: {"claims":[]}`;

const VERIFIER_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    claims: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          claim: { type: SchemaType.STRING },
          supported: { type: SchemaType.BOOLEAN },
          evidence: { type: SchemaType.STRING },
        },
        required: ['claim', 'supported', 'evidence'],
      },
    },
  },
  required: ['claims'],
};

// Same 5xx quarantine the composer uses (slice 0026): a verifier primary that 5xx-storms
// is skipped and routed to GEMINI_VERIFIER_FALLBACK_MODEL (which may be a `nim:` id) for
// COMPOSE_503_QUARANTINE_MINUTES minutes, instead of re-storming every lead.
const verifierQuarantine = createQuarantine('COMPOSE_503_QUARANTINE_MINUTES', 'verifier');

function parseVerdicts(text: string): ClaimVerdict[] {
  // Strip markdown code fences if model wraps response
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Verifier returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (
    typeof parsed !== 'object' || parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).claims)
  ) {
    throw new Error(`Verifier JSON missing claims array: ${text.slice(0, 200)}`);
  }

  const claims = (parsed as { claims: unknown[] }).claims;
  return claims.map((c, i) => {
    if (
      typeof c !== 'object' || c === null ||
      typeof (c as Record<string, unknown>).claim !== 'string' ||
      typeof (c as Record<string, unknown>).supported !== 'boolean' ||
      typeof (c as Record<string, unknown>).evidence !== 'string'
    ) {
      throw new Error(`Verifier claim[${i}] has wrong shape`);
    }
    return c as ClaimVerdict;
  });
}

async function callGeminiVerifier(
  draft: { subject: string; body: string },
  declaredClaims: ComposedClaim[],
  bundle: VerificationBundle,
): Promise<ClaimVerdict[]> {
  // SEPARATE model from the composer (GEMINI_VERIFIER_MODEL) — an independent model
  // fact-checking the composer's output, never the same one that wrote it.
  const verifierModel = getString('GEMINI_VERIFIER_MODEL');
  const fallbackModel = getString('GEMINI_VERIFIER_FALLBACK_MODEL');
  const timeoutMs = getNumber('GEMINI_TIMEOUT_MS');

  // Trim vision to the only two fields the verifier rules cite (strengths +
  // opportunities). designEra / widgetVisibility / mobileResponsive were echoed on
  // every verify call but never graded — pure input-token waste.
  const visionForVerify = bundle.vision
    ? { strengths: bundle.vision.strengths, opportunities: bundle.vision.opportunities }
    : null;
  const userPayload = {
    draft: { subject: draft.subject, body: draft.body },
    declaredClaims,
    evidence: {
      signals: bundle.signals ?? {},
      vision: visionForVerify,
      psi: bundle.psi ?? null,
    },
  };

  const callModel = async (modelId: string, label: string): Promise<ClaimVerdict[]> => {
    const generate = makeGenerate({
      modelId, systemInstruction: SYSTEM_VERIFIER,
      responseSchema: VERIFIER_RESPONSE_SCHEMA, json: true,
    });
    const result = await withGeminiRate(
      signal => generate(JSON.stringify(userPayload), signal, timeoutMs),
      label,
      { timeoutMs, model: modelId },
    );
    return parseVerdicts(result.response.text().trim());
  };

  const hasFallback = !!fallbackModel && fallbackModel !== verifierModel;

  // Primary quarantined → skip it, go straight to fallback.
  if (verifierQuarantine.isQuarantined() && hasFallback) {
    console.warn(`[gemini] verifier primary quarantined, routing direct to fallback=${fallbackModel}`);
    return callModel(fallbackModel, 'verify-fallback');
  }

  try {
    const out = await callModel(verifierModel, 'verify');
    verifierQuarantine.recordSuccess();
    return out;
  } catch (err) {
    // RPD exhaustion is a run-pause control signal — never a 5xx strike; propagate.
    if (err instanceof GeminiRpdExhausted) throw err;
    const d = describeGeminiError(err);
    if (d.status !== null && d.status >= 500) {
      verifierQuarantine.record5xx(verifierModel);
      if (hasFallback) {
        console.warn(`[gemini] verifier 5xx (status=${d.status}), trying fallback=${fallbackModel}`);
        return callModel(fallbackModel, 'verify-fallback');
      }
    }
    throw err;
  }
}

export async function verifyDraft(
  draft: { subject: string; body: string },
  declaredClaims: ComposedClaim[],
  bundle: VerificationBundle,
): Promise<VerificationResult> {
  try {
    const claims = await callGeminiVerifier(draft, declaredClaims, bundle);
    const hasViolations = claims.some(c => !c.supported);
    return {
      status: hasViolations ? 'violations' : 'ok',
      claims,
    };
  } catch (err) {
    // RPD exhaustion is a run-pause control signal, not a verify failure — let it
    // propagate so the batch pauses resumably instead of dead-lettering the item.
    if (err instanceof GeminiRpdExhausted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[geminiVerifier] verifyDraft failed:', message);
    return { status: 'verifier_failed', error: message, claims: [] };
  }
}
