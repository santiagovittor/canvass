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

export type BatchRunStatus = 'running' | 'paused' | 'done' | 'canceled';

// Mirrors the SSE batch:progress payload (camelCase counters from batch_runs).
export interface BatchProgress {
  runId: string;
  status: BatchRunStatus;
  total: number;
  processed: number;
  skippedNoEvidence: number;
  heldGeneric: number;
  queuedForSend: number;
  failed: number;
  pauseReason: string | null;
}

export function startBatch(businessIds: string[], dryRun: boolean): Promise<{ runId: string }> {
  return request('/batch', { method: 'POST', body: JSON.stringify({ businessIds, dryRun }) });
}

export function getBatch(runId: string): Promise<{ run: BatchProgress; items: unknown[] }> {
  return request(`/batch/${runId}`);
}

export function pauseBatch(runId: string): Promise<{ ok: boolean }> {
  return request(`/batch/${runId}/pause`, { method: 'POST' });
}

export function resumeBatch(runId: string): Promise<{ ok: boolean }> {
  return request(`/batch/${runId}/resume`, { method: 'POST' });
}

export function cancelBatch(runId: string): Promise<{ ok: boolean }> {
  return request(`/batch/${runId}/cancel`, { method: 'POST' });
}
