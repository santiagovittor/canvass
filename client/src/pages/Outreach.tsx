import { useState, useEffect, useCallback, useRef } from 'react';
import { LeadQueue } from '../components/Outreach/LeadQueue';
import type { QueueMode } from '../components/Outreach/LeadQueue';
import { EmailComposer } from '../components/Outreach/EmailComposer';
import { BusinessContext } from '../components/Outreach/BusinessContext';
import { generateEmail, generateFollowUp, skipFollowUp, sendOutreachEmail, getOutreachStats, analyzeWebsite, getSignatureHtml, saveDraft, loadDraft } from '../lib/outreachApi';
import { patchOutreach, getConfig } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import type { OutreachLead, OutreachStats, WebsiteAnalysis } from '../lib/outreachApi';

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
  const [stats, setStats] = useState<OutreachStats | null>(null);
  const [signatureHtml, setSignatureHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');

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

  const handleLeadsChange = useCallback((rows: OutreachLead[]) => {
    queueLeadsRef.current = rows;
  }, []);

  // Mount: load stats + signature + sender config
  useEffect(() => {
    fetchStats();
    getSignatureHtml().then(html => {
      setSignatureHtml(html);
      console.log('[Outreach] signature:', html ? 'loaded (' + html.length + ' chars)' : 'NULL — preview will have no signature');
    });
    getConfig().then(cfg => {
      setSenderName(cfg.senderName);
      setSenderEmail(cfg.senderEmail);
    }).catch(() => {});
  }, [fetchStats]);

  const handleGenerate = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (!lead || isAnalyzingRef.current || isGeneratingRef.current || isSendingRef.current) return;
    setIsGenerating(true);
    setError(null);
    try {
      const result = modeRef.current === 'followup'
        ? await generateFollowUp(lead.id)
        : await generateEmail(lead.id);
      setDraft({ subject: result.subject, body: result.body });
      setIsAiDraft(true);
      setSavingState('saving');
      saveDraft(lead.id, result.subject, result.body, true)
        .then(() => setSavingState('saved'))
        .catch(() => setSavingState('idle'));
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
      const result = await generateEmail(lead.id, currentAnalysis);
      setDraft({ subject: result.subject, body: result.body });
      setIsAiDraft(true);
      setSavingState('saving');
      saveDraft(lead.id, result.subject, result.body, true)
        .then(() => setSavingState('saved'))
        .catch(() => setSavingState('idle'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const handleSend = useCallback(async () => {
    const lead = activeLeadRef.current;
    if (!lead || isGeneratingRef.current || isSendingRef.current) return;
    setIsSending(true);
    setError(null);
    try {
      const result = await sendOutreachEmail(lead.id, draft.subject, draft.body);
      if (!result.success) {
        setError(result.error ?? 'Send failed');
        return;
      }
      setDraft({ subject: '', body: '' });
      setIsAiDraft(false);
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
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setIsSending(false);
    }
  }, [draft, fetchStats, onEmailSent]);

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

  // Live updates from open tracking + reply detection
  useSSE({
    'email:opened': () => {
      if (modeRef.current === 'followup') setLeadRefreshTrigger(n => n + 1);
    },
    'email:replied': () => {
      setLeadRefreshTrigger(n => n + 1);
      fetchStats();
    },
  });

  const handleModeChange = useCallback((m: QueueMode) => {
    setMode(m);
    setActiveLead(null);
    setPendingLead(null);
    setDraft({ subject: '', body: '' });
    setIsAiDraft(false);
    setAnalysis(null);
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
    setError(null);
    setSavingState('idle');
    loadDraft(lead.id).then(d => {
      if (!d) return;
      setDraft({ subject: d.subject, body: d.body });
      setIsAiDraft(d.isAiDraft);
      setSavingState('saved');
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
      <LeadQueue
        activeLead={activeLead}
        onSelect={handleSelectLead}
        onLeadsChange={handleLeadsChange}
        refreshTrigger={leadRefreshTrigger}
        mode={mode}
        onModeChange={handleModeChange}
        onMarkReplied={handleMarkReplied}
      />
      <EmailComposer
        mode={mode}
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
        onSend={handleSend}
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
      />
    </div>
  );
}
