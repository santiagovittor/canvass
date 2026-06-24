const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

// Mirrors the server ActiveRun union (services/activeRuns.ts). The client trusts
// these shapes (server validates its own boundaries).
export type ActiveRun =
  | { type: 'scrape'; jobId: string; status: string; businessesFound: number; cellCount: number; cellsDone: number }
  | { type: 'keyword'; jobId: string; runId: string | null; stage: string | null; query: string; startedAt: string }
  | { type: 'batch'; runId: string; status: string; total: number; processed: number; queuedForSend: number; skippedNoEvidence: number; heldGeneric: number; failed: number; pauseReason: string | null }
  | { type: 'premium'; running: number; pending: number };

// One-shot hydration on mount (not a poll) — live updates arrive via SSE.
export function getActiveRuns(): Promise<ActiveRun[]> {
  return request('/runs/active');
}
