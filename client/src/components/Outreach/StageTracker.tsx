import { useEffect, useState } from 'react';
import type { OutreachLead } from '../../lib/outreachApi';
import { useStageProgress, type StageName, type StepStatus } from '../../hooks/useStageProgress';

type Lang = 'es' | 'en';
type Mode = 'analyze' | 'generate' | 'full';

const ORDER: StageName[] = ['render', 'signatures', 'psi', 'vision', 'compose', 'verify', 'gate'];
const PREMIUM: StageName[] = ['render', 'signatures', 'psi', 'vision'];

// Weighted by typical duration so the bar reflects real progress, not equal slices.
const WEIGHT: Record<StageName, number> = {
  render: 8, signatures: 0.5, psi: 6, vision: 12, compose: 6, verify: 9, gate: 0.5,
};
// Expected per-stage duration (ms) — used only to partially fill the active segment
// so the bar advances smoothly without ever claiming a stage is finished.
const EXPECTED_MS: Record<StageName, number> = {
  render: 8000, signatures: 500, psi: 6000, vision: 12000, compose: 6000, verify: 9000, gate: 500,
};

const SHORT: Record<Lang, Record<StageName, string>> = {
  es: { render: 'Sitio', signatures: 'Tecnología', psi: 'Velocidad', vision: 'Visión', compose: 'Redacción', verify: 'Verificar', gate: 'Control' },
  en: { render: 'Site', signatures: 'Tech', psi: 'Speed', vision: 'Vision', compose: 'Compose', verify: 'Verify', gate: 'Gate' },
};
const WITTY: Record<Lang, Record<StageName, string>> = {
  es: {
    render: 'Cargando el sitio…',
    signatures: 'Detectando qué tecnología usa…',
    psi: 'Midiendo qué tan rápido carga…',
    vision: 'Mirando el sitio con ojos de IA…',
    compose: 'Redactando en tu tono…',
    verify: 'Chequeando que no digamos nada falso…',
    gate: 'Última revisión antes de enviar…',
  },
  en: {
    render: 'Loading the site…',
    signatures: 'Sniffing out its tech stack…',
    psi: 'Clocking how fast it loads…',
    vision: 'Looking at the site with AI eyes…',
    compose: 'Writing in your voice…',
    verify: 'Fact-checking every claim…',
    gate: 'Final gate before send…',
  },
};

const mono = { fontFamily: 'var(--font-mono)' } as const;

function StepDot({ status }: { status: StepStatus }) {
  if (status === 'done' || status === 'cached') {
    return <span style={{ ...mono, fontSize: 11, color: status === 'cached' ? 'var(--text-muted)' : 'var(--success)' }}>✓</span>;
  }
  if (status === 'failed') return <span style={{ ...mono, fontSize: 11, color: 'var(--error)' }}>✕</span>;
  if (status === 'retrying') {
    return <span style={{ ...mono, fontSize: 11, color: 'var(--warn)', animation: 'dotPulse 1s ease-in-out infinite' }}>⟳</span>;
  }
  if (status === 'active') {
    return (
      <span
        className="outreach-dot-pulse"
        style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'dotPulse 1s ease-in-out infinite' }}
      />
    );
  }
  // pending
  return <span style={{ width: 6, height: 6, borderRadius: '50%', border: '1px solid var(--border-strong)' }} />;
}

export function StageTracker({ lead, mode, active }: { lead: OutreachLead | null; mode: Mode; active: boolean; premiumPresent: boolean }) {
  const lang: Lang = lead?.locCountry === 'Argentina' ? 'es' : 'en';
  const progress = useStageProgress(lead?.id ?? null, active);

  // Local UI tick to advance the active segment + per-stage timer. Not a data poll.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || progress.done) return;
    const t = setInterval(() => setTick(n => n + 1), 200);
    return () => clearInterval(t);
  }, [active, progress.done]);

  if (!active && !progress.done) return null;

  const scope = mode === 'analyze' ? PREMIUM : ORDER;
  // generate mode runs only compose/verify/gate; the premium steps already ran on the
  // prior analyze and are credited as cached — honest, the work really was done.
  const cached = new Set<StageName>(mode === 'generate' ? PREMIUM : []);

  const effective = (s: StageName): StepStatus => progress.status[s] ?? (cached.has(s) ? 'cached' : 'pending');

  const totalW = scope.reduce((sum, s) => sum + WEIGHT[s], 0);
  let filledW = 0;
  for (const s of scope) {
    const st = effective(s);
    if (st === 'done' || st === 'cached' || st === 'failed') filledW += WEIGHT[s];
  }
  if (progress.activeStage && scope.includes(progress.activeStage) && progress.activeStartedAt) {
    const el = Date.now() - progress.activeStartedAt;
    const frac = Math.min(el / EXPECTED_MS[progress.activeStage], 0.95);
    filledW += WEIGHT[progress.activeStage] * frac;
  }
  const rawPct = totalW > 0 ? (filledW / totalW) * 100 : 0;
  const pct = progress.done ? 100 : Math.min(Math.round(rawPct), 97);

  const activeElapsed = progress.activeStartedAt ? (Date.now() - progress.activeStartedAt) / 1000 : 0;

  let caption: React.ReactNode;
  if (progress.done) {
    const ok = progress.summary?.error == null;
    caption = (
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: ok ? 'var(--success)' : 'var(--error)' }}>
        {ok ? (lang === 'es' ? 'Listo ✓' : 'Done ✓') : (lang === 'es' ? 'Error' : 'Failed')}
        {progress.summary?.totalMs != null && <span style={{ ...mono, color: 'var(--text-muted)', marginLeft: 8 }}>{(progress.summary.totalMs / 1000).toFixed(1)}s</span>}
        {progress.summary?.costUsd != null && <span style={{ ...mono, color: 'var(--text-muted)', marginLeft: 8 }}>${progress.summary.costUsd.toFixed(4)}</span>}
      </span>
    );
  } else if (progress.retry) {
    const secs = progress.retry.retryDelayMs ? ` ${(progress.retry.retryDelayMs / 1000).toFixed(0)}s` : '';
    caption = (
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--warn)' }}>
        {lang === 'es' ? `Reintentando — esperando al servidor${secs}…` : `Retrying — waiting for the server${secs}…`}
      </span>
    );
  } else if (progress.activeStage) {
    caption = (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>{WITTY[lang][progress.activeStage]}</span>
        <span style={{ ...mono, fontSize: 11, color: 'var(--text-muted)' }}>{activeElapsed.toFixed(1)}s</span>
      </span>
    );
  } else {
    caption = <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)' }}>…</span>;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: '10px 14px',
      background: 'var(--bg-elevated)', border: '1px solid var(--hairline)', borderRadius: 8,
      flexShrink: 0,
    }}>
      {/* caption + percentage */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        {caption}
        <span style={{ ...mono, fontSize: 12, color: progress.done ? 'var(--success)' : 'var(--accent)' }}>{pct}%</span>
      </div>

      {/* weighted progress bar */}
      <div style={{ height: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', boxShadow: '0 0 12px var(--accent-glow)', transition: 'width 240ms ease' }} />
      </div>

      {/* step chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {scope.map(s => {
          const st = effective(s);
          const isActive = st === 'active' || st === 'retrying';
          const color = isActive ? 'var(--accent)'
            : st === 'done' ? 'var(--text-secondary)'
            : st === 'failed' ? 'var(--error)'
            : 'var(--text-muted)';
          return (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <StepDot status={st} />
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color, fontWeight: isActive ? 500 : 400 }}>{SHORT[lang][s]}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
