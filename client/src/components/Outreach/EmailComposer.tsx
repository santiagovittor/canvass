import { useState, useRef, useEffect } from 'react';
import type { OutreachLead, DetectedSig, PsiMetrics } from '../../lib/outreachApi';

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
  premium: { status: string; renderOutcome: string | null; detectedSigs?: DetectedSig[]; psi?: PsiMetrics | null } | null;
  onSend: () => void;
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

export function EmailComposer({
  mode, lead, draft, isAiDraft, isAnalyzing, isGenerating, isSending,
  remaining, error, savingState, onDraftChange, onAnalyzeAndGenerate, onGenerate,
  onPremiumAnalyze, premium, onSend, onSkip,
  signatureHtml, senderName, senderEmail,
  pendingLead, onConfirmSwitch, onCancelSwitch,
}: EmailComposerProps) {
  const [isSent, setIsSent] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirmingSend, setConfirmingSend] = useState(false);
  const [expandedSig, setExpandedSig] = useState<string | null>(null);
  const sendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the current busy cycle started with an analysis step
  const hadAnalyzingRef = useRef(false);

  useEffect(() => {
    setPreviewing(false);
    setConfirmingSend(false);
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
        @media (prefers-reduced-motion: reduce) {
          .outreach-dot-pulse { animation: none !important; }
        }
      `}</style>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-base)',
        padding: '16px 20px',
        gap: 12,
        overflow: 'hidden',
      }}>

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
                  transition: 'background 200ms',
                  ...(isGenerating ? shimmerStyle : { background: 'var(--bg-elevated)' }),
                }}
                onFocus={e => { if (!isGenerating) e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
              />
            </div>

            {/* Body */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, minHeight: 0 }}>
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
                  transition: 'background 200ms',
                  minHeight: 160,
                  ...(isGenerating ? shimmerStyle : { background: 'var(--bg-elevated)' }),
                }}
                onFocus={e => { if (!isGenerating) e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
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
            border: '1px solid var(--border)',
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
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 14px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            flexShrink: 0,
          }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-secondary)', minWidth: 0 }}>
              Send to{' '}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' }}>
                {lead.first_email}
              </span>
              ?
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
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '6px 16px',
                  borderRadius: 6,
                  border: 'none',
                  background: 'var(--accent)',
                  color: 'var(--accent-ink)',
                  cursor: 'pointer',
                }}
              >
                Confirm Send ✉
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

        {/* Premium analysis trigger + status chip */}
        {hasWebsite && !confirmingSend && (
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
        {hasWebsite && !confirmingSend && premium?.status === 'done' && !!premium.detectedSigs?.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <div style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--text-muted)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
            }}>
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
                <div key={cat} style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4, alignItems: 'flex-start' }}>
                  <span style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 10,
                    color: 'var(--text-muted)',
                    minWidth: 54,
                    paddingTop: 3,
                  }}>{catLabel[cat]}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {sigs.map(sig => (
                      <div key={sig.id}>
                        <button
                          onClick={() => setExpandedSig(expandedSig === sig.id ? null : sig.id)}
                          style={{
                            fontFamily: 'var(--font-ui)',
                            fontSize: 11,
                            padding: '2px 8px',
                            borderRadius: 100,
                            border: '1px solid var(--border-strong)',
                            background: expandedSig === sig.id ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                            color: expandedSig === sig.id ? 'var(--accent)' : 'var(--text-secondary)',
                            cursor: 'pointer',
                          }}
                        >
                          {sig.name}
                        </button>
                        {expandedSig === sig.id && (
                          <div style={{
                            marginTop: 4,
                            padding: '5px 8px',
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
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
        {hasWebsite && !confirmingSend && premium?.status === 'done' && premium.renderOutcome === 'ok' && premium.psi && premium.psi.mobileScore !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-muted)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
            }}>
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

        {/* Skip analysis option */}
        {hasWebsite && !confirmingSend && (
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

        {/* Error */}
        {error && (
          <p
            role="alert"
            aria-live="assertive"
            style={{
              margin: 0,
              fontFamily: 'var(--font-ui)',
              fontSize: 13,
              color: 'var(--error)',
              flexShrink: 0,
            }}
          >
            {error}
          </p>
        )}
      </div>
    </>
  );
}
