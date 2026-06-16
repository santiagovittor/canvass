import { useEffect, useRef, useState } from 'react';
import { useSSE } from './useSSE';

// Live step-tracker state for one lead, fed by the server's `outreach:stage` SSE
// stream (premiumAnalyzer + outreachComposePipeline emit it). Determinate, never
// fakes completion: a step only flips to done when the server says so, and a
// retrying/waiting stage is surfaced as such.

export type StageName =
  | 'render' | 'signatures' | 'psi' | 'vision'
  | 'compose' | 'verify' | 'gate';

export type StepStatus = 'pending' | 'active' | 'done' | 'cached' | 'failed' | 'retrying';

interface StageEvent {
  id?: string;
  businessId?: string;
  stage?: StageName;
  phase?: 'start' | 'end' | 'retry' | 'done';
  status?: 'ok' | 'failed' | 'cached';
  durationMs?: number;
  retryDelayMs?: number | null;
  attempt?: number;
  totalMs?: number;
  costUsd?: number;
  anchor?: string | null;
  disposition?: string | null;
  error?: string | null;
}

export interface StageProgress {
  status: Partial<Record<StageName, StepStatus>>;
  activeStage: StageName | null;
  activeStartedAt: number | null;
  retry: { stage: StageName; retryDelayMs: number | null } | null;
  done: boolean;
  summary: { costUsd?: number; totalMs?: number; anchor?: string | null; disposition?: string | null; error?: string | null } | null;
}

const EMPTY: StageProgress = {
  status: {}, activeStage: null, activeStartedAt: null, retry: null, done: false, summary: null,
};

export function useStageProgress(businessId: string | null, active: boolean): StageProgress {
  const [progress, setProgress] = useState<StageProgress>(EMPTY);
  const businessIdRef = useRef(businessId);
  businessIdRef.current = businessId;
  const wasActive = useRef(false);

  // Reset on the leading edge of an action so a fresh run starts clean.
  useEffect(() => {
    if (active && !wasActive.current) setProgress(EMPTY);
    wasActive.current = active;
  }, [active]);

  useSSE({
    'outreach:stage': (data) => {
      const d = data as StageEvent;
      if (!d.businessId || d.businessId !== businessIdRef.current) return;
      setProgress(prev => {
        const next: StageProgress = { ...prev, status: { ...prev.status } };
        if (d.phase === 'start' && d.stage) {
          next.status[d.stage] = 'active';
          next.activeStage = d.stage;
          next.activeStartedAt = Date.now();
          next.retry = null;
          next.done = false;
        } else if (d.phase === 'retry' && d.stage) {
          next.status[d.stage] = 'retrying';
          next.retry = { stage: d.stage, retryDelayMs: d.retryDelayMs ?? null };
        } else if (d.phase === 'end' && d.stage) {
          next.status[d.stage] = d.status === 'cached' ? 'cached' : d.status === 'failed' ? 'failed' : 'done';
          if (next.activeStage === d.stage) { next.activeStage = null; next.activeStartedAt = null; }
          next.retry = null;
        } else if (d.phase === 'done') {
          next.done = true;
          next.activeStage = null;
          next.activeStartedAt = null;
          next.summary = { costUsd: d.costUsd, totalMs: d.totalMs, anchor: d.anchor, disposition: d.disposition, error: d.error };
        }
        return next;
      });
    },
  });

  return progress;
}
