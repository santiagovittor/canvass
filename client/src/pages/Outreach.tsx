import { useState, useEffect, useCallback, useRef } from 'react';
import { LeadQueue } from '../components/Outreach/LeadQueue';
import type { QueueMode } from '../components/Outreach/LeadQueue';
import { EmailComposer } from '../components/Outreach/EmailComposer';
import { WhatsAppComposer } from '../components/Outreach/WhatsAppComposer';
import { BusinessContext } from '../components/Outreach/BusinessContext';
import { BatchRunner } from '../components/Outreach/BatchRunner';
import { startBatch, pauseBatch, resumeBatch, cancelBatch } from '../lib/batchApi';
import type { BatchProgress } from '../lib/batchApi';
import { getActiveRuns } from '../lib/activeRunsApi';
import { generateEmail, generateFollowUp, skipFollowUp, sendOutreachEmail, getOutreachStats, analyzeWebsite, getSignatureHtml, saveDraft, loadDraft, startPremiumAnalysis, getPremiumAnalysis, scheduleDraft, listScheduled, cancelScheduled, rescheduleScheduled, getLeadScheduleStatus, getScheduledQueueStatus, pauseScheduler, resumeScheduler, cancelScheduledById, cancelScheduledByBusiness, cancelAllPending, generateWaMessage, markWaContacted, setReplyType } from '../lib/outreachApi';
import { patchOutreach, getConfig } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import type { OutreachLead, RepliedLead, OutreachStats, WebsiteAnalysis, DetectedSig, PsiMetrics, VisionResult, PremiumSignal, ScheduledSend, ScheduledSendRow, ScheduledQueueStatus } from '../lib/outreachApi';

interface Draft {
  subject: string;
  body: string;
}

function parseSavedAnalysis(raw: string | null): WebsiteAnalysis | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WebsiteAnalysis;
    return parsed?.loadedSuccessfully === true ? parsed : null;
  } catch {
    return null;
  }
}

interface OutreachProps {
  onEmailSent: () => void;
}

export function Outreach({ onEmailSent }: OutreachProps) {
  const [mode, setMode] = useState<QueueMode>('new');
  const [activeLead, setActiveLead] = useState<OutreachLead | null>(null);
  const [pendingLead, setPendingLead] = useState<OutreachLead | null>(null);
  const [leadRefreshTrigger, setLeadRefreshTrigger] = useState(0);
  const queueLeadsRef = useRef<OutreachLead[]>([]);
  const [draft, setDraft] = useState<Draft>({ subject: '', body: '' });
  const [isAiDraft, setIsAiDraft] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [analysis, setAnalysis] = useState<WebsiteAnalysis | null>(null);
  const [premium, setPremium] = useState<{ status: string; renderOutcome: string | null; detectedSigs?: DetectedSig[]; psi?: PsiMetrics | null; vision?: VisionResult | null; signals?: Record<string, PremiumSignal> | null } | null>(null);
  const [verificationVerdict, setVerificationVerdict] = useState<{ status: string; violations?: Array<{ claim: string; evidence: string }> } | null>(null);
  const [stats, setStats] = useState<OutreachStats | null>(null);
  const [signatureHtml, setSignatureHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [scheduled, setScheduled] = useState<ScheduledSend[]>([]);
  const [leadScheduleRow, setLeadScheduleRow] = useState<ScheduledSendRow | null>(null);
  const [queueStatus, setQueueStatus] = useState<ScheduledQueueStatus | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const batchRunIdRef = useRef<string | null>(null);

  // Keep mutable refs for use inside keyboard listener without stale closure
  const activeLeadRef = useRef<OutreachLead | null>(null);
  const isAnalyzingRef = useRef(false);
  const isGeneratingRef = useRef(false);
  const isSendingRef = useRef(false);
  const modeRef = useRef<QueueMode>('new');
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeLeadRef.current = activeLead;
  isAnalyzingRef.current = isAnalyzing;
  isGeneratingRef.current = isGenerating;
  isSendingRef.current = isSending;
  modeRef.current = mode;

  const fetchStats = useCallback(async () => {
    try {
      const s = await getOutreachStats();
      setStats(s);
    } catch (err) { console.error('[Outreach]', err); }
  }, []);

  const fetchScheduled = useCallback(async () => {
    try {
      setScheduled(await listScheduled());
    } catch (err) { console.error('[Outreach]', err); }
  }, []);

  const fetchQueueStatus = useCallback(async () => {
    try { setQueueStatus(await getScheduledQueueStatus()); } catch { /* non-fatal */ }
  }, []);

  const handlePauseScheduler = useCallback(async (reason?: string) => {
    await pauseScheduler(reason);
    await fetchQueueStatus();
  }, [fetchQueueStatus]);

  const handleResumeScheduler = useCallback(async () => {
    await resumeScheduler();
    await fetchQueueStatus();
  }, [fetchQueueStatus]);

  const handleCancelScheduledById = useCallback(async (id: string) => {
    await cancelScheduledById(id);
    await fetchQueueStatus();
  }, [fetchQueueStatus]);

  const handleCancelAllPending = useCallback(async () => {
    await cancelAllPending();
    await fetchQueueStatus();
  }, [fetchQueueStatus]);

  const handleLeadsChange = useCallback((rows: OutreachLead[]) => {
    queueLeadsRef.current = rows;
    setQueueCount(rows.length);
  }, []);

  function rememberSavedAnalysis(leadId: string, saved: WebsiteAnalysis) {
    const serialized = JSON.stringify(saved);
    queueLeadsRef.current = queueLeadsRef.current.map(row =>
      row.id === leadId ? { ...row, outreachAnalysisJson: serialized } : row,
    );
    setActiveLead(current =>
      current?.id === leadId ? { ...current, outreachAnalysisJson: serialized } : current,
    );
  }

  const handleStartBatch = useCallback(async (size: number, dryRun: boolean) => {
    const ids = queueLeadsRef.current.slice(0, size).map(l => l.id);
    if (ids.length === 0) return;
    setError(null);
    try {
      const { runId } = await startBatch(ids, dryRun);
      batchRunIdRef.current = runId;
      // optimistic initial state; live counts arrive via SSE batch:progress
      setBatchProgress({
        runId, status: 'running', total: ids.length, processed: 0,
        skippedNoEvidence: 0, heldGeneric: 0, queuedForSend: 0, failed: 0, pauseReason: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch failed to start');
    }
  }, []);

  const handlePauseBatch = useCallback(() => {
    if (batchRunIdRef.current) pauseBatch(batchRunIdRef.current).catch(() => {});
  }, []);
  const handleResumeBatch = useCallback(() => {
    if (batchRunIdRef.current) resumeBatch(batchRunIdRef.current).catch(() => {});
  }, []);
  const handleCancelBatch = useCallback(() => {
    if (batchRunIdRef.current) cancelBatch(batchRunIdRef.current).catch(() => {});
  }, []);

  // Mount: load stats + signature + sender config + scheduled queue
  useEffect(() => {
    fetchStats();
    fetchScheduled();
    fetchQueueStatus();
    // Rehydrate an in-flight batch run (slice 0012) so returning to Outreach shows
    // live counts instead of an empty BatchRunner. Live updates continue via SSE.
    getActiveRuns().then(runs => {
      const batch = runs.find(r => r.type === 'batch');
      if (batch && batch.type === 'batch') {
        batchRunIdRef.current = batch.runId;
        setBatchProgress({
          runId: batch.runId, status: batch.status as BatchProgress['status'],
          total: batch.total, processed: batch.processed,
          skippedNoEvidence: batch.skippedNoEvidence, heldGeneric: batch.heldGeneric,
          queuedForSend: batch.queuedForSend, failed: batch.failed, pauseReason: batch.pauseReason,
        });
      }
    }).catch(() => {});
    getSignatureHtml().then(html => {
      setSignatureHtml(html);
      console.log('[Outreach] signature:', html ? 'loaded (' + html.length + ' chars)' : 'NULL — preview will have no signature');
    });
    getConfig().then(cfg => {
      setSenderName(cfg.senderName);
      setSenderEmail(cfg.senderEmail);
    }).catch(() => {});
    // Queue status + active-lead schedule update live via the send-scheduler:tick
    // SSE event (see useSSE below) — no polling loop.
  }, [fetchStats, fetchScheduled, fetchQueueStatus]);

  const handleGenerate = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (modeRef.current === 'replied') return;
    if (!lead || isAnalyzingRef.current || isGeneratingRef.current || isSendingRef.current) return;
    setIsGenerating(true);
    setError(null);
    try {
      if (modeRef.current === 'followup') {
        const result = await generateFollowUp(lead.id);
        setDraft({ subject: result.subject, body: result.body });
        setIsAiDraft(true);
        setSavingState('saving');
        saveDraft(lead.id, result.subject, result.body, true)
          .then(() => setSavingState('saved'))
          .catch(() => setSavingState('idle'));
      } else {
        // Server saves draft + verification atomically — no client-side saveDraft needed
        const result = await generateEmail(lead.id);
        setDraft({ subject: result.subject, body: result.body });
        setIsAiDraft(true);
        setVerificationVerdict(result.verification ?? null);
        setSavingState('saved');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  }, []);

  // No-site lane (slice 0007): AI-draft the WhatsApp offer (server persists it via
  // upsertDraft) and surface it in the editor. Reuses the draft.body channel.
  const handleGenerateWa = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (!lead || isGeneratingRef.current) return;
    setIsGenerating(true);
    setError(null);
    try {
      const { message } = await generateWaMessage(lead.id);
      setDraft({ subject: '', body: message });
      setIsAiDraft(true);
      setSavingState('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  }, []);

  // Manual-send model: operator sends via wa.me/tel: externally, then marks the
  // lead contacted — which flips outreach_status and drops it from the queue.
  const handleMarkContacted = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (!lead) return;
    setError(null);
    const rows = queueLeadsRef.current;
    const idx = rows.findIndex(r => r.id === lead.id);
    setActiveLead(rows[idx + 1] ?? rows[idx - 1] ?? null);
    setDraft({ subject: '', body: '' });
    setIsAiDraft(false);
    try {
      await markWaContacted(lead.id);
      setLeadRefreshTrigger(n => n + 1);
    } catch (err) { console.error('[Outreach]', err); }
  }, []);

  const handleAnalyzeAndGenerate = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (modeRef.current === 'replied') return;
    if (!lead || isAnalyzingRef.current || isGeneratingRef.current || isSendingRef.current) return;
    setIsAnalyzing(true);
    setError(null);
    let currentAnalysis: WebsiteAnalysis | null = null;
    try {
      currentAnalysis = await analyzeWebsite(lead.id);
      if (currentAnalysis.loadedSuccessfully) {
        setAnalysis(currentAnalysis);
        rememberSavedAnalysis(lead.id, currentAnalysis);
      }
    } catch (err) {
      setIsAnalyzing(false);
      setError(err instanceof Error ? err.message : 'Analysis failed');
      return;
    }
    setIsAnalyzing(false);
    setIsGenerating(true);
    try {
      // Server saves draft + verification atomically — no client-side saveDraft needed
      const result = await generateEmail(lead.id, currentAnalysis);
      setDraft({ subject: result.subject, body: result.body });
      setIsAiDraft(true);
      setVerificationVerdict(result.verification ?? null);
      setSavingState('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const handlePremiumAnalyze = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (!lead) return;
    setError(null);
    try {
      await startPremiumAnalysis(lead.id);
      setPremium({ status: 'pending', renderOutcome: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Premium analysis failed to start');
    }
  }, []);

  const doSend = useCallback(async (override = false) => {
    const lead = activeLeadRef.current;
    if (modeRef.current === 'replied') return;
    if (!lead || isGeneratingRef.current || isSendingRef.current) return;
    setIsSending(true);
    setError(null);
    try {
      const result = await sendOutreachEmail(lead.id, draft.subject, draft.body, override ? { override: true } : undefined);
      if (!result.success) {
        setError(result.error ?? 'Send failed');
        return;
      }
      setDraft({ subject: '', body: '' });
      setIsAiDraft(false);
      setVerificationVerdict(null);
      onEmailSent();
      // navigate after 800ms (pulse animation in EmailComposer) then refetch
      setTimeout(() => {
        const rows = queueLeadsRef.current;
        const idx = rows.findIndex(r => r.id === lead.id);
        setActiveLead(rows[idx + 1] ?? rows[idx - 1] ?? null);
        setLeadRefreshTrigger(n => n + 1);
        fetchStats();
      }, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      // 409 means verification gate held the draft — surface a clean message
      if (msg.startsWith('409')) {
        setError('Draft held for verification — regenerate or use "Send anyway" to override.');
      } else {
        setError(msg);
      }
    } finally {
      setIsSending(false);
    }
  }, [draft, fetchStats, onEmailSent]);

  const handleSend = useCallback(() => doSend(false), [doSend]);
  const handleForceSend = useCallback(() => doSend(true), [doSend]);

  const handleSchedule = useCallback(async (opts: { sendAt?: string; optimalWindow?: boolean }) => {
    const lead = activeLeadRef.current;
    if (modeRef.current === 'replied') return;
    if (!lead) return;
    setError(null);
    try {
      await scheduleDraft(lead.id, opts);
      await fetchScheduled();
      // Advance to the next lead — the draft persists server-side for the worker
      // to read live at fire time; we don't delete it.
      const rows = queueLeadsRef.current;
      const idx = rows.findIndex(r => r.id === lead.id);
      setActiveLead(rows[idx + 1] ?? rows[idx - 1] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Schedule failed');
    }
  }, [fetchScheduled]);

  const handleCancelScheduled = useCallback(async (id: string) => {
    try {
      await cancelScheduled(id);
      await fetchScheduled();
    } catch (err) { console.error('[Outreach]', err); }
  }, [fetchScheduled]);

  const handleRescheduleScheduled = useCallback(async (id: string, sendAt: string) => {
    try {
      await rescheduleScheduled(id, sendAt);
      await fetchScheduled();
    } catch (err) { console.error('[Outreach]', err); }
  }, [fetchScheduled]);

  const handleSkip = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (modeRef.current === 'replied') return;
    if (!lead || isGeneratingRef.current || isSendingRef.current) return;
    const rows = queueLeadsRef.current;
    const idx = rows.findIndex(r => r.id === lead.id);
    setActiveLead(rows[idx + 1] ?? rows[idx - 1] ?? null);
    setDraft({ subject: '', body: '' });
    setIsAiDraft(false);
    try {
      // Follow-up skip leaves outreach_status untouched — the lead stays 'contacted'
      if (modeRef.current === 'followup') {
        await skipFollowUp(lead.id);
      } else {
        await patchOutreach(lead.id, 'skip');
      }
      setLeadRefreshTrigger(n => n + 1);
    } catch (err) { console.error('[Outreach]', err); }
  }, []);

  const handleMarkReplied = useCallback(async (lead: OutreachLead) => {
    const rows = queueLeadsRef.current;
    const idx = rows.findIndex(r => r.id === lead.id);
    if (activeLeadRef.current?.id === lead.id) {
      setActiveLead(rows[idx + 1] ?? rows[idx - 1] ?? null);
      setDraft({ subject: '', body: '' });
      setIsAiDraft(false);
    }
    try {
      await patchOutreach(lead.id, 'replied');
      setLeadRefreshTrigger(n => n + 1);
      fetchStats();
    } catch (err) { console.error('[Outreach]', err); }
  }, [fetchStats]);

  // Operator reclassify (slice 0014): flip a replied lead auto↔real. SSE also fires
  // email:replied, but the optimistic refresh keeps the single-client case instant.
  const handleReclassify = useCallback(async (lead: RepliedLead, to: 'auto' | 'real') => {
    try {
      await setReplyType(lead.id, to);
      setLeadRefreshTrigger(n => n + 1);
      fetchStats();
    } catch (err) { console.error('[Outreach]', err); }
  }, [fetchStats]);

  // Live updates from open tracking + reply detection + premium analysis progress
  useSSE({
    'send-scheduler:tick': (data) => {
      setQueueStatus(data as ScheduledQueueStatus);
      if (activeLeadRef.current) {
        getLeadScheduleStatus(activeLeadRef.current.id)
          .then(row => setLeadScheduleRow(row))
          .catch(() => {});
      }
    },
    'email:opened': () => {
      if (modeRef.current === 'followup') setLeadRefreshTrigger(n => n + 1);
    },
    'email:replied': () => {
      setLeadRefreshTrigger(n => n + 1);
      fetchStats();
    },
    'batch:progress': (data) => {
      const d = data as BatchProgress;
      // Track only the run this client started.
      if (batchRunIdRef.current && d.runId !== batchRunIdRef.current) return;
      setBatchProgress(d);
    },
    'premium:progress': (data) => {
      const d = data as { businessId?: string; status?: string; renderOutcome?: string | null };
      if (!d.businessId || d.businessId !== activeLeadRef.current?.id || !d.status) return;
      if (d.status === 'done') {
        getPremiumAnalysis(d.businessId).then(a => {
          if (a) setPremium({ status: a.status, renderOutcome: a.renderOutcome, detectedSigs: a.detectedSigs, psi: a.psi, vision: a.vision, signals: a.signals });
        }).catch(() => {
          setPremium({ status: d.status!, renderOutcome: d.renderOutcome ?? null });
        });
      } else {
        setPremium({ status: d.status, renderOutcome: d.renderOutcome ?? null });
      }
    },
  });

  const handleModeChange = useCallback((m: QueueMode) => {
    setMode(m);
    setActiveLead(null);
    setPendingLead(null);
    setDraft({ subject: '', body: '' });
    setIsAiDraft(false);
    setAnalysis(null);
    setPremium(null);
    setVerificationVerdict(null);
    setError(null);
    setSavingState('idle');
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // No-site lane uses its own buttons, not the email send/skip/generate keys.
      if (modeRef.current === 'no-site') return;
      if (!activeLeadRef.current || isAnalyzingRef.current || isGeneratingRef.current || isSendingRef.current) return;
      if (e.key === 's' || e.key === 'S') handleSend();
      if (e.key === 'x' || e.key === 'X') handleSkip();
      if (e.key === 'r' || e.key === 'R') handleGenerate();
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSend, handleSkip, handleGenerate]);

  function handleDraftChange(d: Draft) {
    setDraft(d);
    setIsAiDraft(false);
    setVerificationVerdict(null); // user-edited drafts bypass verification gate
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    const lead = activeLeadRef.current;
    if (!lead) return;
    setSavingState('idle');
    draftSaveTimerRef.current = setTimeout(() => {
      const currentLead = activeLeadRef.current;
      if (!currentLead) return;
      setSavingState('saving');
      saveDraft(currentLead.id, d.subject, d.body, false)
        .then(() => setSavingState('saved'))
        .catch(() => setSavingState('idle'));
    }, 1500);
  }

  function doSelectLead(lead: OutreachLead) {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    setActiveLead(lead);
    setPendingLead(null);
    setDraft({ subject: '', body: '' });
    setIsAiDraft(false);
    setAnalysis(parseSavedAnalysis(lead.outreachAnalysisJson));
    setPremium(null);
    setVerificationVerdict(null);
    setError(null);
    setSavingState('idle');
    setLeadScheduleRow(null);
    getLeadScheduleStatus(lead.id)
      .then(row => setLeadScheduleRow(row))
      .catch(() => {});
    getPremiumAnalysis(lead.id).then(a => {
      if (a) setPremium({ status: a.status, renderOutcome: a.renderOutcome, detectedSigs: a.detectedSigs, psi: a.psi, vision: a.vision, signals: a.signals });
    }).catch(() => {});
    loadDraft(lead.id).then(d => {
      if (!d) return;
      setDraft({ subject: d.subject, body: d.body });
      setIsAiDraft(d.isAiDraft);
      setSavingState('saved');
      if (d.verificationJson) {
        try {
          const parsed = JSON.parse(d.verificationJson) as { status: string; claims?: Array<{ claim: string; supported: boolean; evidence: string }> };
          setVerificationVerdict({
            status: parsed.status,
            violations: (parsed.claims ?? []).filter(c => !c.supported).map(c => ({ claim: c.claim, evidence: c.evidence })),
          });
        } catch { /* ignore malformed */ }
      }
    }).catch(() => {});
  }

  function handleSelectLead(lead: OutreachLead) {
    if (activeLead && lead.id !== activeLead.id) {
      const hasDirtyDraft = (draft.subject.trim() || draft.body.trim()) && savingState !== 'saved';
      if (hasDirtyDraft) {
        setPendingLead(lead);
        return;
      }
    }
    doSelectLead(lead);
  }

  function handleConfirmSwitch() {
    if (pendingLead) doSelectLead(pendingLead);
  }

  function handleCancelSwitch() {
    setPendingLead(null);
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '300px 1fr 320px',
      height: 'calc(100vh - 44px)',
      background: 'var(--bg-base)',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
        {mode === 'new' && (
          <BatchRunner
            progress={batchProgress}
            queueCount={queueCount}
            onStart={handleStartBatch}
            onPause={handlePauseBatch}
            onResume={handleResumeBatch}
            onCancel={handleCancelBatch}
          />
        )}
        <LeadQueue
          activeLead={activeLead}
          onSelect={handleSelectLead}
          onLeadsChange={handleLeadsChange}
          refreshTrigger={leadRefreshTrigger}
          mode={mode}
          onModeChange={handleModeChange}
          onMarkReplied={handleMarkReplied}
          onReclassify={handleReclassify}
          style={{ flex: 1, minHeight: 0, borderRight: 'none' }}
        />
      </div>
      {mode === 'no-site' ? (
        <WhatsAppComposer
          lead={activeLead}
          message={draft.body}
          isGenerating={isGenerating}
          error={error}
          savingState={savingState}
          onMessageChange={msg => handleDraftChange({ subject: '', body: msg })}
          onGenerate={handleGenerateWa}
          onMarkContacted={handleMarkContacted}
        />
      ) : (
      <EmailComposer
        mode={mode === 'followup' ? 'followup' : 'new'}
        lead={mode === 'replied' ? null : activeLead}
        draft={draft}
        isAiDraft={isAiDraft}
        isAnalyzing={isAnalyzing}
        isGenerating={isGenerating}
        isSending={isSending}
        remaining={stats?.remaining ?? 30}
        error={error}
        savingState={savingState}
        onDraftChange={handleDraftChange}
        onAnalyzeAndGenerate={handleAnalyzeAndGenerate}
        onGenerate={handleGenerate}
        onPremiumAnalyze={handlePremiumAnalyze}
        premium={premium}
        onSend={handleSend}
        onForceSend={handleForceSend}
        onSchedule={handleSchedule}
        verificationVerdict={verificationVerdict}
        onSkip={handleSkip}
        signatureHtml={signatureHtml}
        senderName={senderName}
        senderEmail={senderEmail}
        pendingLead={pendingLead}
        onConfirmSwitch={handleConfirmSwitch}
        onCancelSwitch={handleCancelSwitch}
        leadScheduleRow={leadScheduleRow}
      />
      )}
      <BusinessContext
        lead={activeLead}
        analysis={analysis}
        onMarkReplied={mode === 'followup' && activeLead ? () => handleMarkReplied(activeLead) : undefined}
        scheduled={scheduled}
        onCancelScheduled={handleCancelScheduled}
        onRescheduleScheduled={handleRescheduleScheduled}
        queueStatus={queueStatus}
        onPauseScheduler={handlePauseScheduler}
        onResumeScheduler={handleResumeScheduler}
        onCancelScheduledById={handleCancelScheduledById}
        onCancelAllPending={handleCancelAllPending}
      />
    </div>
  );
}
