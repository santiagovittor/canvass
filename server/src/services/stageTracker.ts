import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { broadcast } from '../sse';

// One stage-event layer feeding both the human-readable server log AND the live
// `outreach:stage` SSE stream the UI step tracker consumes. Built once, called from
// premiumAnalyzer (render → signatures → psi → vision) and outreachComposePipeline
// (compose → verify → gate). The Gemini rate limiter reaches in (via the async-local
// context) to report retries and accumulate per-analysis cost without threading args.

export type StageName =
  | 'render' | 'signatures' | 'psi' | 'vision'
  | 'compose' | 'verify' | 'gate';

export type StagePhase = 'start' | 'end' | 'retry' | 'done';

interface AnalysisCtx {
  id: string;
  businessId: string;
  stage: StageName | null;
  startedAt: number;
  costUsd: number;
  summary: { anchor?: string | null; disposition?: string | null };
}

const als = new AsyncLocalStorage<AnalysisCtx>();

export function currentAnalysisId(): string | null {
  return als.getStore()?.id ?? null;
}

function shortId(): string {
  return randomBytes(3).toString('hex');
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Wrap a whole orchestration unit (a premium analysis, or a compose→verify run).
// Logs a start + a `✓ done` / `✗ failed` line with the accumulated cost, and emits
// a terminal `done` SSE event. Stages run inside fire their own start/end events.
export async function withAnalysis<T>(
  businessId: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: AnalysisCtx = {
    id: shortId(),
    businessId,
    stage: null,
    startedAt: Date.now(),
    costUsd: 0,
    summary: {},
  };
  return als.run(ctx, async () => {
    try {
      const result = await fn();
      const totalMs = Date.now() - ctx.startedAt;
      const bits = [
        ctx.summary.anchor != null ? `anchor=${ctx.summary.anchor}` : null,
        ctx.summary.disposition != null ? `disposition=${ctx.summary.disposition}` : null,
        `est cost $${ctx.costUsd.toFixed(4)}`,
      ].filter(Boolean).join(', ');
      console.log(`[${ctx.id}] ✓ ${label} done ${fmtSecs(totalMs)} — ${bits}`);
      broadcast('outreach:stage', {
        id: ctx.id, businessId, phase: 'done', status: 'ok',
        totalMs, costUsd: Number(ctx.costUsd.toFixed(4)),
        anchor: ctx.summary.anchor ?? null, disposition: ctx.summary.disposition ?? null,
      });
      return result;
    } catch (err) {
      const totalMs = Date.now() - ctx.startedAt;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${ctx.id}] ✗ ${label} failed ${fmtSecs(totalMs)} — ${msg}`);
      broadcast('outreach:stage', {
        id: ctx.id, businessId, phase: 'done', status: 'failed',
        totalMs, costUsd: Number(ctx.costUsd.toFixed(4)), error: msg,
      });
      throw err;
    }
  });
}

// Wrap a single stage. No-op logging/SSE if called outside an analysis context.
export async function stage<T>(name: StageName, fn: () => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) return fn();
  ctx.stage = name;
  const startedAt = Date.now();
  console.log(`[${ctx.id}] ▶ ${name} …`);
  broadcast('outreach:stage', { id: ctx.id, businessId: ctx.businessId, stage: name, phase: 'start' });
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    console.log(`[${ctx.id}] ▶ ${name} … ok ${fmtSecs(durationMs)}`);
    broadcast('outreach:stage', { id: ctx.id, businessId: ctx.businessId, stage: name, phase: 'end', status: 'ok', durationMs });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.log(`[${ctx.id}] ▶ ${name} … failed ${fmtSecs(durationMs)}`);
    broadcast('outreach:stage', { id: ctx.id, businessId: ctx.businessId, stage: name, phase: 'end', status: 'failed', durationMs });
    throw err;
  }
}

// Mark a stage as a no-op (already cached / skipped) — credits done work honestly
// in the tracker without faking a run.
export function stageCached(name: StageName): void {
  const ctx = als.getStore();
  if (!ctx) return;
  broadcast('outreach:stage', { id: ctx.id, businessId: ctx.businessId, stage: name, phase: 'end', status: 'cached', durationMs: 0 });
}

// Called by the rate limiter from inside a stage when a retry is scheduled, so the
// UI shows honest waiting/retrying instead of a frozen bar.
export function reportRetry(retryDelayMs: number | null, attempt: number): void {
  const ctx = als.getStore();
  if (!ctx || !ctx.stage) return;
  broadcast('outreach:stage', {
    id: ctx.id, businessId: ctx.businessId, stage: ctx.stage,
    phase: 'retry', retryDelayMs: retryDelayMs ?? null, attempt,
  });
}

export function addCost(usd: number): void {
  const ctx = als.getStore();
  if (ctx) ctx.costUsd += usd;
}

// Identify the active analysis/lead for the cost ledger. Null when a Gemini call
// runs outside an analysis context (e.g. a one-off script), in which case the
// ledger row is still written, just without lead attribution.
export function currentCostMeta(): { analysisId: string; businessId: string } | null {
  const ctx = als.getStore();
  return ctx ? { analysisId: ctx.id, businessId: ctx.businessId } : null;
}

export function setSummary(partial: { anchor?: string | null; disposition?: string | null }): void {
  const ctx = als.getStore();
  if (ctx) ctx.summary = { ...ctx.summary, ...partial };
}
