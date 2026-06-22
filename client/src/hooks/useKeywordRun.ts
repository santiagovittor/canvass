import { useCallback, useEffect, useRef, useState } from 'react';
import { useSSE } from './useSSE';

// Stage tracker for an instant keyword run (slice 0003). The keyword route is
// synchronous, so the client mints a runId, passes it in the POST body, and
// matches the keyword:* SSE events back to its own run. No fetching here —
// state is driven entirely by the events plus a render-only elapsed clock.
export type KeywordStage =
  | 'idle'
  | 'submitting'
  | 'scraping'
  | 'saving'
  | 'enriching'
  | 'done'
  | 'error';

interface KeywordStageEvent { runId: string; stage: 'scraping' | 'saving' | 'enriching'; }
interface KeywordDoneEvent { runId: string; added: number; deduped: number; }
interface KeywordErrorEvent { runId: string; message: string; }

export interface KeywordRun {
  stage: KeywordStage;
  elapsedMs: number;
  added: number | null;
  deduped: number | null;
  error: string | null;
  start: (runId: string) => void;
  reset: () => void;
}

const ACTIVE: KeywordStage[] = ['submitting', 'scraping', 'saving', 'enriching'];

export function useKeywordRun(): KeywordRun {
  const [stage, setStage] = useState<KeywordStage>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [added, setAdded] = useState<number | null>(null);
  const [deduped, setDeduped] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs so the once-registered SSE handlers always read the current run.
  const runIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const active = ACTIVE.includes(stage);
  const matches = (e: { runId: string }) =>
    runIdRef.current !== null && e.runId === runIdRef.current;
  const elapsedNow = () =>
    startedAtRef.current === null ? 0 : Date.now() - startedAtRef.current;

  // Render-only 1s clock — ticks elapsed between SSE events (mirrors
  // JobProgress.tsx:46-52). Stops once the run leaves an active stage.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsedMs(elapsedNow()), 1000);
    return () => clearInterval(t);
  }, [active]);

  useSSE({
    'keyword:started': (data) => {
      // Server ack; the run already shows 'submitting'. Match only.
      if (!matches(data as { runId: string })) return;
    },
    'keyword:stage': (data) => {
      const e = data as KeywordStageEvent;
      if (!matches(e)) return;
      setStage(e.stage);
    },
    'keyword:done': (data) => {
      const e = data as KeywordDoneEvent;
      if (!matches(e)) return;
      setStage('done');
      setAdded(e.added);
      setDeduped(e.deduped);
      setElapsedMs(elapsedNow());
    },
    'keyword:error': (data) => {
      const e = data as KeywordErrorEvent;
      if (!matches(e)) return;
      setStage('error');
      setError(e.message);
      setElapsedMs(elapsedNow());
    },
  });

  const start = useCallback((runId: string) => {
    runIdRef.current = runId;
    startedAtRef.current = Date.now();
    setStage('submitting');
    setElapsedMs(0);
    setAdded(null);
    setDeduped(null);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    runIdRef.current = null;
    startedAtRef.current = null;
    setStage('idle');
    setElapsedMs(0);
    setAdded(null);
    setDeduped(null);
    setError(null);
  }, []);

  return { stage, elapsedMs, added, deduped, error, start, reset };
}
