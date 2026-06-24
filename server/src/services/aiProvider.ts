import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ResponseSchema } from '@google/generative-ai';
import { request } from 'undici';
import { env } from '../env';

// Provider seam (slice 0026). One generate function the composer + verifier call
// *through* withGeminiRate, so a NIM (OpenAI-compatible) call can stand in for a Gemini
// call without touching the rate/timeout/retry/RPD/cost machinery. The only result shape
// those sites consume is `.response.text()` and (in recordCost) `.response.usageMetadata`,
// so the NIM path masquerades as a Gemini result of exactly that subset.

export interface GenResult {
  response: {
    text(): string;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };
}

export type Provider = 'gemini' | 'nim';

// Provider is derived from the model id: a `nim:` prefix routes to NVIDIA NIM, anything
// else stays Gemini. This keeps the existing string settings (GEMINI_MODEL, the fallback
// models) as the single switch — set `nim:<model-id>` from the Settings tab to swap.
const NIM_PREFIX = 'nim:';
export function providerFor(modelId: string): Provider {
  return modelId.startsWith(NIM_PREFIX) ? 'nim' : 'gemini';
}

interface GenerateOpts {
  modelId: string;
  systemInstruction: string;
  responseSchema?: ResponseSchema; // Gemini structured output; NIM uses json_object instead
  json: boolean;                   // request JSON output (NIM response_format)
}

// Build the per-attempt generate fn ONCE per call site, then hand it to withGeminiRate
// (which supplies the AbortSignal + hard timeout). Mirrors the old inline
// `signal => model.generateContent(...)` shape so call sites barely change.
export function makeGenerate(
  opts: GenerateOpts,
): (payloadJson: string, signal: AbortSignal, timeoutMs: number) => Promise<GenResult> {
  return providerFor(opts.modelId) === 'nim'
    ? makeNimGenerate(opts)
    : makeGeminiGenerate(opts);
}

function makeGeminiGenerate(
  opts: GenerateOpts,
): (payloadJson: string, signal: AbortSignal, timeoutMs: number) => Promise<GenResult> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: opts.modelId,
    systemInstruction: opts.systemInstruction,
    ...(opts.responseSchema
      ? { generationConfig: { responseMimeType: 'application/json', responseSchema: opts.responseSchema } }
      : {}),
  });
  // The real GenerateContentResult already satisfies GenResult (text() + usageMetadata).
  return (payloadJson, signal, timeoutMs) =>
    model.generateContent(payloadJson, { signal, timeout: timeoutMs }) as Promise<GenResult>;
}

interface NimResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function makeNimGenerate(
  opts: GenerateOpts,
): (payloadJson: string, signal: AbortSignal, timeoutMs: number) => Promise<GenResult> {
  // No silent default: a NIM model selected without a key is an operator config error.
  if (!env.NVIDIA_NIM_API_KEY) {
    throw new Error('NVIDIA_NIM_API_KEY not set but a NIM model is selected — set it or pick a Gemini model');
  }
  const apiKey = env.NVIDIA_NIM_API_KEY;
  const realModel = opts.modelId.slice(NIM_PREFIX.length);
  // ponytail: NIM shares the Gemini Bottleneck limiter (maxConcurrent=1 + RPM spacing),
  // so calls stay serialized under NIM's ~40 RPM free ceiling at default settings. Give
  // NIM its own reservoir only if the operator raises GEMINI_MAX_CONCURRENT and NIM 429s.
  const url = `${env.NVIDIA_NIM_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`;

  return async (payloadJson, signal, timeoutMs) => {
    const { statusCode, body } = await request(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      body: JSON.stringify({
        model: realModel,
        messages: [
          { role: 'system', content: opts.systemInstruction },
          { role: 'user', content: payloadJson },
        ],
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (statusCode < 200 || statusCode >= 300) {
      const text = await body.text().catch(() => '');
      // Attach .status so withGeminiRate's extractStatus/isRetryable + the quarantine
      // classify NIM 429/5xx exactly like Gemini's (retry → quarantine → fallback).
      throw Object.assign(new Error(`NIM ${realModel} returned ${statusCode}: ${text.slice(0, 200)}`), {
        status: statusCode,
      });
    }

    const json = (await body.json()) as NimResponse;
    const content = json.choices?.[0]?.message?.content ?? '';
    return {
      response: {
        text: () => content,
        usageMetadata: {
          promptTokenCount: json.usage?.prompt_tokens ?? 0,
          candidatesTokenCount: json.usage?.completion_tokens ?? 0,
        },
      },
    };
  };
}
