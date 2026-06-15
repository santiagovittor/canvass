import { useState, useEffect, useCallback, useRef } from 'react';
import { LeadQueue } from '../components/Outreach/LeadQueue';
import type { QueueMode } from '../components/Outreach/LeadQueue';
import { EmailComposer } from '../components/Outreach/EmailComposer';
import { BusinessContext } from '../components/Outreach/BusinessContext';
import { BatchRunner } from '../components/Outreach/BatchRunner';
import { startBatch, pauseBatch, resumeBatch, cancelBatch } from '../lib/batchApi';
import type { BatchProgress } from '../lib/batchApi';
import { generateEmail, generateFollowUp, skipFollowUp, sendOutreachEmail, getOutreachStats, analyzeWebsite, getSignatureHtml, saveDraft, loadDraft, startPremiumAnalysis, getPremiumAnalysis, scheduleDraft, listScheduled, cancelScheduled, rescheduleScheduled } from '../lib/outreachApi';
import { patchOutreach, getConfig } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import type { OutreachLead, OutreachStats, WebsiteAnalysis, DetectedSig, PsiMetrics, VisionResult, PremiumSignal, ScheduledSend } from '../lib/outreachApi';

interface Draft {
  subject: string;
  body: string;
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

  const handleLeadsChange = useCallback((rows: OutreachLead[]) => {
    queueLeadsRef.current = rows;
    setQueueCount(rows.length);
  }, []);

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
    getSignatureHtml().then(html => {
      setSignatureHtml(html);
      console.log('[Outreach] signature:', html ? 'loaded (' + html.length + ' chars)' : 'NULL — preview will have no signature');
    });
    getConfig().then(cfg => {
      setSenderName(cfg.senderName);
      setSenderEmail(cfg.senderEmail);
    }).catch(() => {});
  }, [fetchStats, fetchScheduled]);

  const handleGenerate = useCallback(async () => {
    const lead = activeLeadRef.current;
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

  const handleAnalyzeAndGenerate = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (!lead || isAnalyzingRef.current || isGeneratingRef.current || isSendingRef.current) return;
    setIsAnalyzing(true);
    setError(null);
    let currentAnalysis: WebsiteAnalysis | null = null;
    try {
      currentAnalysis = await analyzeWebsite(lead.id);
      setAnalysis(currentAnalysis);
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

  // Live updates from open tracking + reply detection + premium analysis progress
  useSSE({
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
    setAnalysis(null);
    setPremium(null);
    setVerificationVerdict(null);
    setError(null);
    setSavingState('idle');
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
          style={{ flex: 1, minHeight: 0, borderRight: 'none' }}
        />
      </div>
      <EmailComposer
        mode={mode === 'followup' ? 'followup' : 'new'}
        lead={activeLead}
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
      />
      <BusinessContext
        lead={activeLead}
        analysis={analysis}
        onMarkReplied={mode === 'followup' && activeLead ? () => handleMarkReplied(activeLead) : undefined}
        scheduled={scheduled}
        onCancelScheduled={handleCancelScheduled}
        onRescheduleScheduled={handleRescheduleScheduled}
      />
    </div>
  );
}
