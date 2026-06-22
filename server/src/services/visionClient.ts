import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Part } from '@google/generative-ai';
import { env } from '../env';
import { withGeminiRate, describeGeminiError, GeminiRpdExhausted } from './geminiRateLimiter';
import { getNumber } from './appSettings';

const VISION_MODEL = 'gemini-2.5-flash';

export interface VisionObservation {
  headline: string;   // ≈3–7 words, scannable
  text: string;       // one-sentence detail (kept for back-compat)
  confidence: number; // 0.0–1.0
}

export interface VisionResult {
  strengths: VisionObservation[];      // 2–3, specific and visible
  opportunities: VisionObservation[];  // 2–3, goal-framed
  designEra: string;                   // e.g. "modern", "2015-era WordPress"
  widgetVisibility: {
    whatsapp: 'yes' | 'no' | 'unsure';
    chat:     'yes' | 'no' | 'unsure';
    booking:  'yes' | 'no' | 'unsure';
  };
  mobileResponsive: 'yes' | 'no' | 'unsure';
}

const SYSTEM_PROMPT = `You are a professional web design analyst. Analyze the provided business website screenshots and return observations based ONLY on what is clearly visible.

RULES:
- Return AT MOST 3 strengths and AT MOST 3 opportunities. Rank each list most-important first. Fewer is better — only include what genuinely matters.
- Each observation has a "headline" (3–7 words, terse, scannable) and a "detail" (ONE specific sentence). Do not over-write. No filler, no generic praise.
- Strengths: cite specific visible elements. BAD headline: "Buenas fotos". GOOD headline: "Fotos de platos bien iluminadas". detail: "las fotos tienen fondo neutro y buena iluminación".
- Opportunities: goal-framed — how fixing it helps the business. GOOD headline: "Falta reserva online". detail: "agregar reservas reduciría la fricción para clientes que navegan fuera de horario".
- Confidence: 1.0 = unmistakably clear; 0.7 = fairly certain; below 0.7 omit the item entirely.
- widgetVisibility: only 'yes' if the widget is UNMISTAKABLY visible in the screenshot. Prefer 'unsure' over 'no' when in doubt.
- widgetVisibility.chat means an automated chat/assistant launcher bubble (Intercom/Drift/Tidio/Messenger), NOT a WhatsApp button.
- mobileResponsive: 'yes' if layout adapts cleanly on the mobile screenshot; 'no' if layout breaks, text overflows, or elements overlap on the mobile screenshot; 'unsure' if unclear.
- LANGUAGE: write all headline and detail text in the primary language of the site content (Spanish or English — match the site).

Return ONLY valid JSON matching this exact schema. No markdown fences, no commentary, no extra keys:
{
  "strengths": [{"headline": "...", "detail": "...", "confidence": 0.0}],
  "opportunities": [{"headline": "...", "detail": "...", "confidence": 0.0}],
  "designEra": "...",
  "widgetVisibility": {"whatsapp": "yes|no|unsure", "chat": "yes|no|unsure", "booking": "yes|no|unsure"},
  "mobileResponsive": "yes|no|unsure"
}`;

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

const VALID_TRISTATE = new Set(['yes', 'no', 'unsure']);
type Tristate = 'yes' | 'no' | 'unsure';
function toTristate(v: unknown): Tristate {
  return VALID_TRISTATE.has(v as string) ? (v as Tristate) : 'unsure';
}

// desktopScreenshot is always non-null at the call site (guarded in premiumAnalyzer)
export async function runVision(
  desktopScreenshot: Buffer,
  mobileScreenshot: Buffer | null,
  category: string | null,
  rubric: string,
): Promise<VisionResult | null> {
  if (!env.GEMINI_API_KEY) return null;

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: VISION_MODEL,
    systemInstruction: SYSTEM_PROMPT,
  });

  const parts: Part[] = [
    { text: `Business category: ${category ?? 'unknown'}\n\nRubric — ${rubric}\n\nDesktop screenshot:` },
    { inlineData: { mimeType: 'image/png', data: desktopScreenshot.toString('base64') } },
  ];
  if (mobileScreenshot) {
    parts.push({ text: '\nMobile screenshot:' });
    parts.push({ inlineData: { mimeType: 'image/png', data: mobileScreenshot.toString('base64') } });
  }

  try {
    const visionTimeout = getNumber('GEMINI_VISION_TIMEOUT_MS');
    const result = await withGeminiRate(
      signal => model.generateContent({ contents: [{ role: 'user', parts }] }, { signal, timeout: visionTimeout }),
      'vision',
      { timeoutMs: visionTimeout, model: VISION_MODEL },
    );
    const raw = result.response.text().trim();
    const cleaned = stripFences(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn('[vision] JSON parse failed, degrading to null. Raw:', cleaned.slice(0, 200));
      return null;
    }

    const v = parsed as Record<string, unknown>;
    if (!Array.isArray(v.strengths) || !Array.isArray(v.opportunities)) {
      console.warn('[vision] malformed shape, degrading to null');
      return null;
    }

    // Derive a short headline from a long detail sentence (first ~6 words).
    function deriveHeadline(detail: string): string {
      const words = detail.trim().split(/\s+/);
      const head = words.slice(0, 6).join(' ');
      return words.length > 6 ? head + '…' : head;
    }

    // Tolerant of both the new {headline, detail} shape and the old {text} shape.
    function toObs(arr: unknown[]): VisionObservation[] {
      return arr
        .map(s => {
          const o = s as Record<string, unknown>;
          if (typeof o.confidence !== 'number') return null;
          const detail = typeof o.detail === 'string' ? o.detail
            : typeof o.text === 'string' ? o.text
            : null;
          if (detail === null) return null;
          const headline = typeof o.headline === 'string' && o.headline.trim()
            ? o.headline.trim()
            : deriveHeadline(detail);
          return { headline, text: detail, confidence: o.confidence };
        })
        .filter((o): o is VisionObservation => o !== null);
    }

    const wv = (v.widgetVisibility ?? {}) as Record<string, unknown>;
    return {
      strengths: toObs(v.strengths as unknown[]),
      opportunities: toObs(v.opportunities as unknown[]),
      designEra: typeof v.designEra === 'string' ? v.designEra : 'unknown',
      widgetVisibility: {
        whatsapp: toTristate(wv.whatsapp),
        chat:     toTristate(wv.chat),
        booking:  toTristate(wv.booking),
      },
      mobileResponsive: toTristate(v.mobileResponsive),
    };
  } catch (err) {
    if (err instanceof GeminiRpdExhausted) throw err; // budget cap: propagate, don't degrade
    const d = describeGeminiError(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vision] API error, degrading to null: ${msg} (status=${d.status ?? '?'}${d.quotaLimitValue ? ` limit=${d.quotaLimitValue}` : ''}${d.retryDelayMs != null ? ` retryDelay=${(d.retryDelayMs / 1000).toFixed(1)}s` : ''})`);
    return null;
  }
}
