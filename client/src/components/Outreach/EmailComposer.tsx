import { useState, useRef, useEffect } from 'react';
import type { OutreachLead, DetectedSig, PsiMetrics, VisionResult, VisionObservation, PremiumSignal } from '../../lib/outreachApi';
import { baLocalToUtcIso, defaultScheduleLocal } from '../../lib/outreachApi';

interface Draft {
  subject: string;
  body: string;
}

interface EmailComposerProps {
  mode: 'new' | 'followup';
  lead: OutreachLead | null;
  draft: Draft;
  isAiDraft: boolean;
  isAnalyzing: boolean;
  isGenerating: boolean;
  isSending: boolean;
  remaining: number;
  error: string | null;
  savingState: 'idle' | 'saving' | 'saved';
  onDraftChange: (draft: Draft) => void;
  onAnalyzeAndGenerate: () => void;
  onGenerate: () => void;
  onPremiumAnalyze: () => void;
  premium: { status: string; renderOutcome: string | null; detectedSigs?: DetectedSig[]; psi?: PsiMetrics | null; vision?: VisionResult | null; signals?: Record<string, PremiumSignal> | null } | null;
  onSend: () => void;
  onForceSend: () => void;
  onSchedule: (opts: { sendAt?: string; optimalWindow?: boolean }) => void;
  verificationVerdict: { status: string; violations?: Array<{ claim: string; evidence: string }> } | null;
  onSkip: () => void;
  signatureHtml: string | null;
  senderName: string;
  senderEmail: string;
  pendingLead: OutreachLead | null;
  onConfirmSwitch: () => void;
  onCancelSwitch: () => void;
}

const DAILY_CAP = 30;

function PsiChip({ label, value, bad, warn }: { label: string; value: string; bad: boolean; warn: boolean }) {
  const color = bad ? 'var(--error)' : warn ? 'var(--warn)' : 'var(--success)';
  const bg = bad ? 'rgba(255,77,109,0.1)' : warn ? 'rgba(245,183,0,0.1)' : 'rgba(74,222,128,0.1)';
  return (
    <span style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 100,
      background: bg,
      color,
      display: 'inline-flex',
      gap: 4,
      alignItems: 'center',
    }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {value}
    </span>
  );
}

type VerificationVerdict = { status: string; violations?: Array<{ claim: string; evidence: string }> } | null;

function VerificationPanel({ verdict }: { verdict: VerificationVerdict }) {
  if (!verdict) return null;

  const isHeld = verdict.status === 'held' || verdict.status === 'verifier_failed';
  const isOk = verdict.status === 'ok';
  const isStripped = verdict.status === 'violations_stripped';
  const isOverride = verdict.status === 'override_sent';

  if (isOk) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--success)' }}>✓ Claims verified</span>
      </div>
    );
  }

  if (isStripped) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--warn)' }}>⚠ Claims auto-corrected</span>
      </div>
    );
  }

  if (isOverride) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>Sent with manual override</span>
      </div>
    );
  }

  if (isHeld) {
    const violations = verdict.violations ?? [];
    return (
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid rgba(245,183,0,0.2)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--warn)' }}>
          ⚠ Draft held — verifier {verdict.status === 'verifier_failed' ? 'failed' : 'found unsupported claims'}
        </span>
        {violations.length > 0 && (
          <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {violations.map((v, i) => (
              <li key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                "{v.claim}"
              </li>
            ))}
          </ul>
        )}
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>
          Regenerate to fix, or use "Send anyway" to override.
        </span>
      </div>
    );
  }

  return null;
}

// Tier 1 — uppercase-mono section header, one treatment across DETECTED / PAGESPEED / VISION.
const sectionHeaderStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--text-muted)',
  letterSpacing: '0.11em',
  textTransform: 'uppercase' as const,
};

// Tier 2 — group subheader (Fortalezas / Oportunidades). font-ui + lighter ink
// separates it from the mono section header above and the bold headline below.
const visionSubheaderStyle = {
  fontFamily: 'var(--font-ui)',
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
};

const visionMoreBtnStyle = {
  alignSelf: 'flex-start' as const,
  marginLeft: 14,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'var(--font-ui)',
  fontSize: 11,
  color: 'var(--text-secondary)',
};

const VISION_DETAIL_TRUNC = 90;

function VisionRow({ obs, kind, index }: { obs: VisionObservation; kind: 'strength' | 'opportunity'; index: number }) {
  const [open, setOpen] = useState(false);
  const color = kind === 'strength' ? 'var(--success)' : 'var(--warn)';
  // New rows: distinct headline + detail. Old rows (no headline): the sentence IS the line, no second tier.
  const headline = obs.headline ?? obs.text;
  const detail = obs.headline ? obs.text : null;
  const longDetail = !!detail && detail.length > VISION_DETAIL_TRUNC;
  const shownDetail = detail && longDetail && !open
    ? detail.slice(0, VISION_DETAIL_TRUNC).trimEnd() + '…'
    : detail;
  return (
    <div
      className="outreach-vision-row"
      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', animationDelay: `${index * 40}ms` }}
    >
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        opacity: obs.confidence >= 0.9 ? 1 : 0.5,
        marginTop: 6,
        flexShrink: 0,
      }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-primary)',
          lineHeight: 1.35,
        }}>
          {headline}
        </span>
        {detail && (
          <span
            onClick={longDetail ? () => setOpen(o => !o) : undefined}
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              lineHeight: 1.45,
              color: 'var(--text-secondary)',
              cursor: longDetail ? 'pointer' : 'default',
            }}
          >
            {shownDetail}
          </span>
        )}
      </div>
    </div>
  );
}

function VisionGroup({ label, items, kind }: {
  label: string;
  items: VisionObservation[];
  kind: 'strength' | 'opportunity';
}) {
  const [showAll, setShowAll] = useState(false);
  if (!items.length) return null;
  const shown = showAll ? items : items.slice(0, 3);
  const rest = items.length - 3;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <span style={visionSubheaderStyle}>{label}</span>
      {shown.map((obs, i) => <VisionRow key={i} obs={obs} kind={kind} index={i} />)}
      {rest > 0 && (
        <button style={visionMoreBtnStyle} onClick={() => setShowAll(s => !s)}>
          {showAll ? 'menos' : `+${rest} más`}
        </button>
      )}
    </div>
  );
}

function VisionSection({ vision }: { vision: VisionResult }) {
  const strengths = [...vision.strengths]
    .filter(s => s.confidence >= 0.8)
    .sort((a, b) => b.confidence - a.confidence);
  const opportunities = [...vision.opportunities]
    .filter(s => s.confidence >= 0.75)
    .sort((a, b) => b.confidence - a.confidence);
  if (!strengths.length && !opportunities.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={sectionHeaderStyle}>Vision</span>
        {vision.designEra && (
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {vision.designEra}
          </span>
        )}
      </div>
      <VisionGroup label="Fortalezas" items={strengths} kind="strength" />
      <VisionGroup label="Oportunidades" items={opportunities} kind="opportunity" />
      <div style={{ display: 'flex', gap: 8 }}>
        {(['whatsapp', 'chat', 'booking'] as const).map(k => {
          const v = vision.widgetVisibility[k];
          const color = v === 'yes' ? 'var(--success)' : 'var(--text-muted)';
          const label: Record<string, string> = { whatsapp: 'WA', chat: 'Chat', booking: 'Book' };
          return (
            <span key={k} style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color,
              padding: '1px 6px',
              borderRadius: 4,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--hairline)',
            }}>
              {label[k]} {v}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function EmailComposer({
  mode, lead, draft, isAiDraft, isAnalyzing, isGenerating, isSending,
  remaining, error, savingState, onDraftChange, onAnalyzeAndGenerate, onGenerate,
  onForceSend, onSchedule, verificationVerdict,
  onPremiumAnalyze, premium, onSend, onSkip,
  signatureHtml, senderName, senderEmail,
  pendingLead, onConfirmSwitch, onCancelSwitch,
}: EmailComposerProps) {
  const [isSent, setIsSent] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirmingSend, setConfirmingSend] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleChoice, setScheduleChoice] = useState<'time' | 'optimal'>('time');
  const [scheduleLocal, setScheduleLocal] = useState('');
  const [expandedSig, setExpandedSig] = useState<string | null>(null);
  const sendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the current busy cycle started with an analysis step
  const hadAnalyzingRef = useRef(false);

  useEffect(() => {
    setPreviewing(false);
    setConfirmingSend(false);
    setScheduling(false);
  }, [lead?.id]);

  useEffect(() => {
    if (isAnalyzing) hadAnalyzingRef.current = true;
    if (!isAnalyzing && !isGenerating) hadAnalyzingRef.current = false;
  }, [isAnalyzing, isGenerating]);

  const isMultiStep = hadAnalyzingRef.current || isAnalyzing;

  const words = draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0;
  const wordColor = words === 0 ? 'var(--text-muted)' : words < 60 ? 'var(--text-muted)' : words <= 90 ? 'var(--success)' : 'var(--warn)';

  const sentToday = DAILY_CAP - remaining;
  const canSend = !!(lead?.valid_email) && !isAnalyzing && !isGenerating && !isSending && !isSent && draft.subject.trim() && draft.body.trim();
  // Follow-ups never run website analysis — the angle comes from the original email
  const hasWebsite = mode === 'new' && !!(lead?.website);
  const busy = isAnalyzing || isGenerating || isSending;

  function handleSendClick() {
    if (!canSend) return;
    setConfirmingSend(true);
  }

  function handleConfirmSend() {
    setConfirmingSend(false);
    if (sendTimeoutRef.current) clearTimeout(sendTimeoutRef.current);
    setIsSent(true);
    onSend();
    sendTimeoutRef.current = setTimeout(() => setIsSent(false), 800);
  }

  function handleForceSendConfirm() {
    setConfirmingSend(false);
    if (sendTimeoutRef.current) clearTimeout(sendTimeoutRef.current);
    setIsSent(true);
    onForceSend();
    sendTimeoutRef.current = setTimeout(() => setIsSent(false), 800);
  }

  // Scheduling is allowed even for held/unverified drafts — the same gate runs at
  // fire time, so it never lets a held draft transmit. We only require a complete
  // draft + a deliverable address.
  const canSchedule = !!(lead?.valid_email) && !isAnalyzing && !isGenerating && !isSending && !isSent && !!draft.subject.trim() && !!draft.body.trim();

  function handleScheduleClick() {
    if (!canSchedule) return;
    setScheduleLocal(defaultScheduleLocal());
    setScheduleChoice('time');
    setConfirmingSend(false);
    setScheduling(true);
  }

  function handleConfirmSchedule() {
    if (scheduleChoice === 'optimal') onSchedule({ optimalWindow: true });
    else onSchedule({ sendAt: baLocalToUtcIso(scheduleLocal) });
    setScheduling(false);
  }

  const isVerdictHeld = verificationVerdict?.status === 'held' || verificationVerdict?.status === 'verifier_failed';

  const shimmerStyle = {
    background: 'linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-hover) 50%, var(--bg-elevated) 75%)',
    backgroundSize: '200% 100%',
    animation: 'outreachShimmer 1.4s ease-in-out infinite',
  };

  if (!lead) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base)',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
      }}>
        Select a lead to begin
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes outreachShimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes dotPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.8); }
        }
        @keyframes visionRowIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        /* Staggered enter for vision rows (delay set inline per index). Matches the
           app's quint ease-out (globals.css). */
        .outreach-vision-row { animation: visionRowIn 320ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        @media (prefers-reduced-motion: reduce) {
          .outreach-dot-pulse { animation: none !important; }
          .outreach-vision-row { animation: none !important; }
        }
      `}</style>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-base)',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}>

        {/* Chrome — switch guard, preview toggle, shortcut legend. Fixed above the
            two scrolling panes so it never scrolls away. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 20px 10px', flexShrink: 0 }}>

        {/* Switch guard — unsaved draft warning */}
        {pendingLead && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 14px',
            background: 'rgba(245,183,0,0.07)',
            border: '1px solid rgba(245,183,0,0.22)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-sm)',
            flexShrink: 0,
          }}>
            <span style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 13,
              color: 'var(--warn)',
              lineHeight: 1.3,
            }}>
              Switching will clear your unsaved draft.
            </span>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={onCancelSwitch}
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 12,
                  fontWeight: 500,
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border-strong)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Keep editing
              </button>
              <button
                onClick={onConfirmSwitch}
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 12,
                  fontWeight: 500,
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: '1px solid rgba(245,183,0,0.35)',
                  background: 'rgba(245,183,0,0.1)',
                  color: 'var(--warn)',
                  cursor: 'pointer',
                }}
              >
                Switch anyway
              </button>
            </div>
          </div>
        )}

        {/* Top strip: preview toggle + remaining counter */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={() => setPreviewing(p => !p)}
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              fontWeight: 500,
              padding: '3px 10px',
              borderRadius: 100,
              border: previewing ? 'none' : '1px solid var(--border)',
              cursor: 'pointer',
              background: previewing ? 'var(--accent)' : 'transparent',
              color: previewing ? 'var(--accent-ink)' : 'var(--text-secondary)',
              letterSpacing: '0.04em',
            }}
          >
            {previewing ? 'Edit' : 'Preview'}
          </button>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>sent today</span>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                fontWeight: 500,
                color: sentToday > DAILY_CAP ? 'var(--error)' : sentToday >= 25 ? 'var(--warn)' : 'var(--accent)',
              }}>
                {sentToday} / {DAILY_CAP}
              </span>
            </div>
            {sentToday > DAILY_CAP && (
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--error)' }}>
                Daily suggestion exceeded — proceed with care
              </span>
            )}
          </div>
        </div>

        {/* Shortcut legend */}
        <div style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          color: 'var(--text-muted)',
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>S</span> send
          {' · '}
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>X</span> {mode === 'followup' ? 'skip follow-up' : 'skip'}
          {' · '}
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>R</span> {mode === 'followup' ? 'generate follow-up' : 'regenerate'}
        </div>

        </div>{/* /chrome */}

        {/* COMPOSE PANE — subject, body, send controls. Own scroll, so its footer
            row can never collide with the analysis pane below. Takes the larger
            share (3:2) when an analysis pane is present; full height otherwise. */}
        <div style={{
          flex: hasWebsite && !previewing ? '3 1 0' : '1 1 0',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '4px 20px 14px',
        }}>

        {previewing ? (
          /* Preview panel */
          <>
            <div style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
              flexShrink: 0,
            }}>
              Email preview
            </div>
            <div style={{
              background: '#F5F0E8',
              borderRadius: 8,
              border: '1px solid #DDD8CE',
              padding: '24px',
              height: 480,
              overflowY: 'auto' as const,
              display: 'flex',
              flexDirection: 'column' as const,
              gap: 0,
            }}>
              <div style={{ borderBottom: '1px solid #DDD8CE', paddingBottom: 14, marginBottom: 20 }}>
                <div style={{ fontSize: 17, fontWeight: 500, color: '#1A1612', fontFamily: 'Outfit, system-ui, sans-serif', marginBottom: 10, lineHeight: 1.3 }}>
                  {draft.subject || '(sin asunto)'}
                </div>
                <div style={{ fontSize: 12, color: '#6B6258', fontFamily: 'Outfit, system-ui, sans-serif', lineHeight: 1.8 }}>
                  <span style={{ fontWeight: 600 }}>De:</span>{' '}{senderName} {`<${senderEmail}>`}<br />
                  <span style={{ fontWeight: 600 }}>Para:</span>{' '}{lead.first_email ?? '—'}
                </div>
              </div>
              <div style={{ fontSize: 14, color: '#2A2218', fontFamily: 'Outfit, system-ui, sans-serif', lineHeight: 1.7, whiteSpace: 'pre-wrap' as const, marginBottom: 24 }}>
                {draft.body || ''}
              </div>
              {signatureHtml && (
                <>
                  <div style={{ borderTop: '1px solid #DDD8CE', marginBottom: 20 }} />
                  <div dangerouslySetInnerHTML={{ __html: signatureHtml }} />
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Subject */}
            <div style={{ flexShrink: 0 }}>
              <label htmlFor="email-subject" style={{
                display: 'block',
                fontFamily: 'var(--font-ui)',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginBottom: 6,
              }}>
                Subject
              </label>
              <input
                id="email-subject"
                type="text"
                value={draft.subject}
                onChange={e => onDraftChange({ ...draft, subject: e.target.value })}
                placeholder="Subject line..."
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 14,
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '9px 12px',
                  outline: 'none',
                  boxSizing: 'border-box' as const,
                  transition: 'background 200ms, border-color 150ms, box-shadow 150ms',
                  ...(isGenerating ? shimmerStyle : { background: 'var(--bg-elevated)' }),
                }}
                onFocus={e => { if (!isGenerating) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-dim)'; } }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; }}
              />
            </div>

            {/* Body — grows to fill the compose pane; min-height keeps a full 60–90-word
                draft visible without scrolling the textarea, even on short viewports. */}
            <div style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column' as const }}>
              <label htmlFor="email-body" style={{
                display: 'block',
                fontFamily: 'var(--font-ui)',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginBottom: 6,
                flexShrink: 0,
              }}>
                Body
              </label>
              <textarea
                id="email-body"
                rows={8}
                value={draft.body}
                onChange={e => onDraftChange({ ...draft, body: e.target.value })}
                placeholder="Email body..."
                style={{
                  flex: 1,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  outline: 'none',
                  resize: 'vertical' as const,
                  boxSizing: 'border-box' as const,
                  transition: 'background 200ms, border-color 150ms, box-shadow 150ms',
                  minHeight: 220,
                  ...(isGenerating ? shimmerStyle : { background: 'var(--bg-elevated)' }),
                }}
                onFocus={e => { if (!isGenerating) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-dim)'; } }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; }}
              />
              {/* Word count + draft badge row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, flexShrink: 0 }}>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: wordColor }}>{words}</span>
                  {mode === 'followup' ? ' words · target ≤80' : ' words · target 60–90'}
                </span>
                {(() => {
                  const base = { fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 500, padding: '2px 8px', borderRadius: 100, letterSpacing: '0.04em' } as const;
                  if (savingState === 'saving') return <span style={{ ...base, background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>Saving…</span>;
                  if (savingState === 'saved' && isAiDraft) return <span style={{ ...base, background: 'var(--accent-dim)', color: 'var(--accent)' }}>AI draft · saved</span>;
                  if (savingState === 'saved' && !isAiDraft) return <span style={{ ...base, background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>Draft saved</span>;
                  if (savingState === 'idle' && isAiDraft) return <span style={{ ...base, background: 'var(--accent-dim)', color: 'var(--accent)' }}>AI draft · edit freely</span>;
                  return null;
                })()}
              </div>
            </div>
          </>
        )}

        {/* Progress strip — analyze/generate pipeline */}
        {(isAnalyzing || isGenerating) && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--hairline)',
            borderRadius: 8,
            flexShrink: 0,
          }}>
            {isMultiStep ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    className="outreach-dot-pulse"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: isAnalyzing ? 'var(--accent)' : 'var(--success)',
                      flexShrink: 0,
                      animation: isAnalyzing ? 'dotPulse 1s ease-in-out infinite' : 'none',
                    }}
                  />
                  <span style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 12,
                    color: isAnalyzing ? 'var(--accent)' : 'var(--text-muted)',
                    fontWeight: isAnalyzing ? 500 : 400,
                  }}>
                    Analyzing
                  </span>
                </div>
                <span style={{ color: 'var(--border-strong)', fontSize: 11, userSelect: 'none' as const }}>→</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    className="outreach-dot-pulse"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: isGenerating ? 'var(--accent)' : 'var(--bg-hover)',
                      border: isGenerating ? 'none' : '1px solid var(--border-strong)',
                      flexShrink: 0,
                      animation: isGenerating ? 'dotPulse 1s ease-in-out infinite' : 'none',
                    }}
                  />
                  <span style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 12,
                    color: isGenerating ? 'var(--accent)' : 'var(--text-muted)',
                    fontWeight: isGenerating ? 500 : 400,
                  }}>
                    Generating
                  </span>
                </div>
              </>
            ) : (
              <>
                <div
                  className="outreach-dot-pulse"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                    flexShrink: 0,
                    animation: 'dotPulse 1s ease-in-out infinite',
                  }}
                />
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>
                  Generating email...
                </span>
              </>
            )}
          </div>
        )}

        {/* Send confirmation strip — replaces button row when active */}
        {confirmingSend ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '10px 14px',
            background: 'var(--bg-elevated)',
            border: isVerdictHeld ? '1px solid rgba(245,183,0,0.3)' : '1px solid var(--hairline)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-md), var(--surface-highlight)',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-secondary)', minWidth: 0 }}>
                Send to{' '}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' }}>
                  {lead.first_email}
                </span>
                ?
                {verificationVerdict?.status === 'ok' && (
                  <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--success)' }}>✓ verified</span>
                )}
                {verificationVerdict?.status === 'violations_stripped' && (
                  <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--warn)' }}>⚠ auto-corrected</span>
                )}
              </span>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => setConfirmingSend(false)}
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 12,
                    fontWeight: 500,
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: '1px solid var(--border-strong)',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmSend}
                  disabled={isVerdictHeld}
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '6px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'var(--accent)',
                    color: 'var(--accent-ink)',
                    cursor: isVerdictHeld ? 'not-allowed' : 'pointer',
                    opacity: isVerdictHeld ? 0.4 : 1,
                  }}
                >
                  Confirm Send ✉
                </button>
              </div>
            </div>
            {/* Force-send escape hatch when verifier held the draft */}
            {isVerdictHeld && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--warn)' }}>
                  Draft held — verifier {verificationVerdict?.status === 'verifier_failed' ? 'failed' : 'found unsupported claims'}. Regenerate to fix.
                </span>
                <button
                  onClick={handleForceSendConfirm}
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '4px 12px',
                    borderRadius: 6,
                    border: '1px solid rgba(245,183,0,0.4)',
                    background: 'transparent',
                    color: 'var(--warn)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  Send anyway (unverified)
                </button>
              </div>
            )}
          </div>
        ) : scheduling ? (
          /* Schedule panel — raised strip (depth marks elevation, flat children).
             Secondary action: Send keeps the lone amber accent, Schedule does not. */
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '12px 14px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--hairline)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-md), var(--surface-highlight)',
            flexShrink: 0,
          }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em' }}>
              Schedule send
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['time', 'optimal'] as const).map(c => (
                <button
                  key={c}
                  onClick={() => setScheduleChoice(c)}
                  style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '4px 12px',
                    borderRadius: 100,
                    cursor: 'pointer',
                    border: scheduleChoice === c ? '1px solid var(--accent-dim)' : '1px solid var(--border)',
                    background: scheduleChoice === c ? 'var(--accent-dim)' : 'transparent',
                    color: scheduleChoice === c ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  {c === 'time' ? 'Pick time' : 'Next optimal window'}
                </button>
              ))}
            </div>
            {scheduleChoice === 'time' ? (
              <input
                type="datetime-local"
                value={scheduleLocal}
                onChange={e => setScheduleLocal(e.target.value)}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '7px 10px',
                  outline: 'none',
                  colorScheme: 'dark',
                }}
              />
            ) : (
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                Fires at the next business-type-aware window (BA hours). Exact time chosen on the server.
              </span>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setScheduling(false)}
                style={{
                  fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 500,
                  padding: '6px 14px', borderRadius: 6,
                  border: '1px solid var(--border-strong)', background: 'transparent',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSchedule}
                disabled={scheduleChoice === 'time' && !scheduleLocal}
                style={{
                  fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600,
                  padding: '6px 16px', borderRadius: 6,
                  border: '1px solid var(--border-strong)', background: 'var(--bg-hover)',
                  color: 'var(--text-primary)',
                  cursor: scheduleChoice === 'time' && !scheduleLocal ? 'not-allowed' : 'pointer',
                  opacity: scheduleChoice === 'time' && !scheduleLocal ? 0.4 : 1,
                }}
              >
                Schedule ⏰
              </button>
            </div>
          </div>
        ) : (
          /* Regular button row */
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              className="btn-secondary"
              onClick={onSkip}
              disabled={busy}
              style={{ flex: '0 0 auto' }}
            >
              Skip
            </button>
            <button
              className="btn-secondary"
              onClick={hasWebsite ? onAnalyzeAndGenerate : onGenerate}
              disabled={busy}
              style={{ flex: '0 0 auto' }}
            >
              {isAnalyzing ? 'Analyzing…' : isGenerating ? 'Generating…'
                : mode === 'followup' ? 'Generate follow-up'
                : hasWebsite ? 'Analyze & Generate' : 'Generate'}
            </button>
            <button
              className="btn-secondary"
              onClick={handleScheduleClick}
              disabled={!canSchedule}
              style={{ flex: '0 0 auto' }}
            >
              Schedule ⏰
            </button>
            <button
              className="btn-primary"
              onClick={handleSendClick}
              disabled={!canSend}
              style={{
                flex: 1,
                transition: 'box-shadow 200ms ease',
                ...(isSent ? { boxShadow: '0 0 32px var(--accent-glow)' } : {}),
              }}
            >
              {isSending ? 'Sending…' : 'Send ✉'}
            </button>
          </div>
        )}

        {/* Error — compose-pane scope (kept next to the controls it relates to) */}
        {error && (
          <p role="alert" aria-live="assertive" style={{ margin: 0, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--error)', flexShrink: 0 }}>
            {error}
          </p>
        )}

        </div>{/* /compose pane */}

        {/* ANALYSIS PANE — one grouped, raised surface with its own scroll. Depth
            (shadow + warm top-highlight) marks elevation; content inside stays flat
            (no nested cards). Hidden in preview mode. */}
        {hasWebsite && !previewing && (
          <div style={{ flex: '2 1 0', minHeight: 0, padding: '10px 20px 16px', display: 'flex' }}>
            <div style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              background: 'var(--bg-panel)',
              borderRadius: 'var(--radius-pane)',
              boxShadow: 'var(--shadow-md), var(--surface-highlight)',
              padding: 16,
            }}>

        {/* Premium analysis trigger + status chip */}
        {!confirmingSend && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              className="btn-secondary"
              onClick={onPremiumAnalyze}
              disabled={busy || premium?.status === 'pending' || premium?.status === 'running'}
              style={{ flex: '0 0 auto', fontSize: 12 }}
            >
              Premium scan
            </button>
            {premium && (
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 100,
                background: premium.status === 'failed' ? 'rgba(255,77,109,0.1)' : 'var(--accent-dim)',
                color: premium.status === 'failed' ? 'var(--error)'
                  : premium.status === 'done' && premium.renderOutcome === 'ok' ? 'var(--success)'
                  : premium.status === 'done' ? 'var(--warn)'
                  : 'var(--accent)',
              }}>
                {premium.status === 'pending' ? 'queued'
                  : premium.status === 'running' ? 'rendering…'
                  : premium.status === 'done' ? (premium.renderOutcome ?? 'done')
                  : 'failed'}
              </span>
            )}
          </div>
        )}

        {/* Detected signatures — shown when premium scan is done and found something */}
        {premium?.status === 'done' && !!premium.detectedSigs?.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
            <div style={sectionHeaderStyle}>
              Detected
            </div>
            {(['whatsapp', 'chat', 'booking', 'forms', 'builder', 'analytics'] as const).map(cat => {
              const sigs = premium.detectedSigs!.filter(s => s.category === cat);
              if (!sigs.length) return null;
              const catLabel: Record<string, string> = {
                whatsapp: 'WhatsApp', chat: 'Chat', booking: 'Booking',
                forms: 'Forms', builder: 'Builder', analytics: 'Analytics',
              };
              return (
                <div key={cat} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <span style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    minWidth: 64,
                    flexShrink: 0,
                    paddingTop: 3,
                  }}>{catLabel[cat]}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, alignItems: 'flex-start' }}>
                    {sigs.map(sig => (
                      <div key={sig.id}>
                        <button
                          onClick={() => setExpandedSig(expandedSig === sig.id ? null : sig.id)}
                          style={{
                            fontFamily: 'var(--font-ui)',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 100,
                            border: expandedSig === sig.id ? '1px solid var(--accent-dim)' : '1px solid var(--border)',
                            background: expandedSig === sig.id ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                            color: expandedSig === sig.id ? 'var(--accent)' : 'var(--text-secondary)',
                            cursor: 'pointer',
                            transition: 'border-color 150ms, background 150ms, color 150ms',
                          }}
                        >
                          {sig.name}
                        </button>
                        {expandedSig === sig.id && (
                          <div style={{
                            marginTop: 4,
                            padding: '5px 8px',
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--hairline)',
                            borderRadius: 6,
                            boxShadow: 'var(--shadow-sm)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10,
                            color: 'var(--text-muted)',
                            wordBreak: 'break-all' as const,
                            maxWidth: 260,
                          }}>
                            <span style={{
                              color: 'var(--text-secondary)',
                              fontSize: 9,
                              textTransform: 'uppercase' as const,
                              letterSpacing: '0.06em',
                              marginRight: 4,
                            }}>{sig.evidence.kind}</span>
                            {sig.evidence.value.length > 120
                              ? sig.evidence.value.slice(0, 120) + '…'
                              : sig.evidence.value}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* PSI metrics — shown when premium scan is done, render ok, and PSI data available */}
        {premium?.status === 'done' && premium.renderOutcome === 'ok' && premium.psi && premium.psi.mobileScore !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <div style={sectionHeaderStyle}>
              PageSpeed (mobile)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
              <PsiChip
                label="Score"
                value={`${premium.psi.mobileScore}/100`}
                bad={premium.psi.mobileScore < 50}
                warn={premium.psi.mobileScore < 75}
              />
              {premium.psi.lcp !== null && (
                <PsiChip
                  label="LCP"
                  value={`${(premium.psi.lcp / 1000).toFixed(1)}s`}
                  bad={premium.psi.lcp > 4000}
                  warn={premium.psi.lcp > 2500}
                />
              )}
              {premium.psi.tbt !== null && (
                <PsiChip
                  label="TBT"
                  value={`${premium.psi.tbt}ms`}
                  bad={premium.psi.tbt > 600}
                  warn={premium.psi.tbt > 200}
                />
              )}
              {premium.psi.mobileFriendly !== null && (
                <PsiChip
                  label="Mobile"
                  value={premium.psi.mobileFriendly ? 'OK' : 'issues'}
                  bad={!premium.psi.mobileFriendly}
                  warn={false}
                />
              )}
            </div>
          </div>
        )}

        {/* Vision observations */}
        {premium?.status === 'done' && premium.renderOutcome === 'ok' && premium.vision && (
          <VisionSection key={lead.id} vision={premium.vision} />
        )}

        {/* Verification verdict — shown when premium scan is done and a verdict exists */}
        {premium?.status === 'done' && verificationVerdict && (
          <VerificationPanel verdict={verificationVerdict} />
        )}

        {/* Skip analysis option */}
        {!confirmingSend && (
          <div style={{ textAlign: 'center', flexShrink: 0 }}>
            <button
              onClick={onGenerate}
              disabled={busy}
              style={{
                background: 'none',
                border: 'none',
                cursor: busy ? 'default' : 'pointer',
                fontFamily: 'var(--font-ui)',
                fontSize: 11,
                color: busy ? 'var(--text-muted)' : 'var(--text-secondary)',
                opacity: busy ? 0.4 : 1,
                padding: '2px 0',
                textDecoration: 'underline',
                textDecorationColor: 'var(--border-strong)',
              }}
            >
              Generate without analysis
            </button>
          </div>
        )}

            </div>{/* /analysis card */}
          </div>
        )}
      </div>
    </>
  );
}
