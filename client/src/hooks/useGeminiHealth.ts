import { useState } from 'react';
import { useSSE } from './useSSE';

// Always-on Gemini health, driven entirely by the server's gemini:health SSE event
// (snapshot on connect + transitions thereafter). No polling. Mirrors the server's
// GeminiHealth shape in server/src/services/geminiHealth.ts.
export type GeminiHealthStatus = 'healthy' | 'low' | 'exhausted';

export interface GeminiHealth {
  status: GeminiHealthStatus;
  rpdCount: number;
  rpdCeiling: number;
  provider: { exhausted: boolean; since: number | null; reason: string | null };
}

const INITIAL: GeminiHealth = {
  status: 'healthy',
  rpdCount: 0,
  rpdCeiling: 0,
  provider: { exhausted: false, since: null, reason: null },
};

export function useGeminiHealth(): GeminiHealth {
  const [health, setHealth] = useState<GeminiHealth>(INITIAL);
  useSSE({
    'gemini:health': (data) => setHealth(data as GeminiHealth),
  });
  return health;
}
