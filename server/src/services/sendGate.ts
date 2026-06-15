import { getDraft } from '../db';
import { SEND_ALLOWED_STATUSES, type VerificationResult, type ClaimVerdict } from './geminiVerifier';

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: string; violations?: ClaimVerdict[] };

type Draft = ReturnType<typeof getDraft>;

// Single, faithful status-based extraction of the inline /send gate. Route AND
// worker share this so they can never drift. NO override path and NO disposition
// check live here — this stays exactly the route's legacy behavior so a human can
// still send a user-edited draft (isAiDraft=false) or a legacy draft as before.
//
// SEND_ALLOWED_STATUSES (= ['ok','violations_stripped']) is safe to allow because
// composeVerifiedEmail is the sole writer of verification_json and only stamps
// those statuses when a supported, prospect-specific anchor survived (disposition
// 'sent_specific'); every husk is held_generic and excluded. The AUTONOMOUS worker
// additionally requires disposition==='sent_specific' on top of this result — see
// scheduledSendWorker — so it can never auto-transmit a husk even if some future
// writer stored a bare 'ok'. A human override is the only way past a held verdict.
export function evaluateSendGate(draft: Draft): GateDecision {
  if (!draft?.isAiDraft) return { allowed: true };

  if (!draft.verificationJson) {
    return { allowed: false, reason: 'Draft not verified — regenerate to verify.' };
  }

  let verdict: VerificationResult;
  try {
    verdict = JSON.parse(draft.verificationJson) as VerificationResult;
  } catch {
    return { allowed: false, reason: 'Verification record unreadable — regenerate to verify.' };
  }

  if (!SEND_ALLOWED_STATUSES.includes(verdict.status)) {
    return {
      allowed: false,
      reason: verdict.error ?? 'Verifier held this draft.',
      violations: verdict.claims?.filter(c => !c.supported) ?? [],
    };
  }
  return { allowed: true };
}

// Parses a draft's stored verdict (or null). Worker uses this for the extra
// disposition gate; keeps JSON-parse tolerance in one place.
export function parseVerdict(draft: Draft): VerificationResult | null {
  if (!draft?.verificationJson) return null;
  try {
    return JSON.parse(draft.verificationJson) as VerificationResult;
  } catch {
    return null;
  }
}
