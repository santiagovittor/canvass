import { Router } from 'express';
import { db } from '../db';
import { businesses } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { getOutreachLeads, getNoSiteLeads, markNoSiteContacted, getDailySendCount, validateEmail, upsertDraft, getDraft, deleteDraft, getDistinctOutreachCategories, saveDraftTopGap, saveDraftVerification, saveEmailExample, getFollowUpLeads, getRepliedLeads, reclassifyReply, setFollowUpStatus, getLatestSentEmail, getLastSentAt, hasOpens, getOutreachSendRow, createScheduledSend, listUpcomingScheduledSends, cancelScheduledSend, rescheduleScheduledSend, saveOutreachAnalysis, supersedeScheduledSendsForBusiness, getMostRecentScheduledSend } from '../db';
import { broadcast } from '../sse';
import { resolveBusinessType, describeWindow } from '../services/outreachSchedulingConfig';
import { nextOptimalWindowUtc } from '../services/outreachGovernor';
import { composeFollowUp, composeWhatsApp } from '../services/geminiComposer';
import { type VerificationResult } from '../services/geminiVerifier';
import { composeVerifiedEmail } from '../services/outreachComposePipeline';
import { evaluateSendGate, parseVerdict } from '../services/sendGate';
import { sendEmail, signatureHtml } from '../services/emailSender';
import { selectBestEmail } from '../services/emailVerifier';
import { checkReplies } from '../services/replyChecker';
import { analyzeWebsite } from '../services/websiteAnalyzer';
import type { WebsiteAnalysis } from '../services/websiteAnalyzer';
import { isPersistableWebsiteAnalysis, serializeWebsiteAnalysis } from '../services/outreachAnalysis';
import { requestPremiumAnalysis } from '../services/premiumAnalysisQueue';
import { getBusinessWebsite, getLatestPremiumAnalysis, type DetectedSig, type SignalMap } from '../db/premium';
import { env } from '../env';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from '../services/visionClient';
import { UTC_MINUS_3_OFFSET_MS } from '../util/time';
import { GeminiProviderExhausted } from '../services/geminiRateLimiter';

const DAILY_CAP = 30;

// Non-technical copy + stable code for provider-quota exhaustion on a single-lead
// generate (slice 0020). The client maps the code to the same friendly message and
// the global health chip already reflects the paused state.
const PROVIDER_QUOTA_CODE = 'provider_quota_exhausted';
const PROVIDER_QUOTA_MSG =
  'Gemini quota reached — preparing new emails is paused and will resume automatically when quota frees up.';
function sendGeminiError(res: import('express').Response, err: unknown): void {
  if (err instanceof GeminiProviderExhausted) {
    res.status(503).json({ error: PROVIDER_QUOTA_MSG, code: PROVIDER_QUOTA_CODE });
    return;
  }
  res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
}

const router = Router();

router.get('/leads', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const search = typeof req.query.search === 'string' && req.query.search ? req.query.search : undefined;
  const country = typeof req.query.country === 'string' && req.query.country ? req.query.country : undefined;
  const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
  const hwRaw = req.query.hasWebsite;
  const hasWebsite = hwRaw === '1' || hwRaw === 'true' ? true
    : hwRaw === '0' || hwRaw === 'false' ? false
    : undefined;
  const veRaw = req.query.validEmail;
  const validEmail = veRaw === '1' || veRaw === 'true' ? true
    : veRaw === '0' || veRaw === 'false' ? false
    : undefined;
  const result = getOutreachLeads(page, 25, { search, country, hasWebsite, category, validEmail });
  res.json(result);
});

router.get('/categories', (_req, res) => {
  res.json(getDistinctOutreachCategories());
});

// ── No-website lane (slice 0007) ────────────────────────────────────────────────
// Leads with no website but a phone — structurally absent from /leads (which
// requires an email). A separate WhatsApp cheap-site offer track: manual send via
// wa.me/tel: on the client; the message is AI-drafted and reuses outreach_drafts.

router.get('/no-site-leads', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const search = typeof req.query.search === 'string' && req.query.search ? req.query.search : undefined;
  res.json(getNoSiteLeads(page, 25, { search }));
});

router.post('/wa-generate', async (req, res) => {
  const { businessId } = req.body as { businessId?: unknown };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }

  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });

  try {
    const { message } = await composeWhatsApp({
      name: row.name,
      category: row.category ?? null,
      website: row.website ?? null,
      locCountry: row.locCountry ?? null,
      locNeighbourhood: row.locNeighbourhood ?? null,
      rating: row.rating ?? null,
      reviewCount: row.reviewCount ?? null,
    });
    // Reuse outreach_drafts: WhatsApp message lives in body, subject unused.
    upsertDraft(businessId, '', message, true);
    res.json({ message });
  } catch (err) {
    sendGeminiError(res, err);
  }
});

router.post('/wa-contacted', (req, res) => {
  const { businessId } = req.body as { businessId?: unknown };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }
  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });
  markNoSiteContacted(businessId);
  res.json({ ok: true });
});

router.get('/follow-ups', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const days = Math.max(1, parseInt(String(req.query.days ?? '4'), 10) || 4);
  res.json(getFollowUpLeads(page, 25, days));
});

router.get('/replied', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  res.json(getRepliedLeads(page, 25));
});

// Operator reclassification (slice 0014): flip a reply auto↔real. 'unknown' is the
// classifier's verdict only — the operator picks a definitive side. auto→real makes
// it count as real engagement (analytics.replied()); real→auto dismisses noise.
router.post('/reply-type', (req, res) => {
  const { businessId, replyType } = req.body as { businessId?: unknown; replyType?: unknown };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }
  if (replyType !== 'auto' && replyType !== 'real') {
    return res.status(400).json({ error: "replyType must be 'auto' or 'real'" });
  }
  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });
  if (!reclassifyReply(businessId, replyType)) {
    return res.status(409).json({ error: 'not a replied lead' });
  }
  broadcast('email:replied', { businessId, name: row.name, replyType });
  res.json({ ok: true });
});

router.post('/generate-follow-up', async (req, res) => {
  const { businessId } = req.body as { businessId?: unknown };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }

  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });

  const original = getLatestSentEmail(businessId);
  const lastSentAt = getLastSentAt(businessId);
  const daysSinceSent = lastSentAt
    ? Math.floor((Date.now() - UTC_MINUS_3_OFFSET_MS - new Date(lastSentAt).getTime()) / 86_400_000)
    : null;

  try {
    const result = await composeFollowUp({
      name: row.name,
      category: row.category ?? null,
      website: row.website ?? null,
      locCountry: row.locCountry ?? null,
      locNeighbourhood: row.locNeighbourhood ?? null,
      rating: row.rating ?? null,
      reviewCount: row.reviewCount ?? null,
    }, original, daysSinceSent, hasOpens(businessId));
    res.json(result);
  } catch (err) {
    sendGeminiError(res, err);
  }
});

router.patch('/follow-up/:businessId', (req, res) => {
  const { action } = req.body as { action?: unknown };
  if (action !== 'skip') {
    return res.status(400).json({ error: "action must be 'skip'" });
  }
  const found = setFollowUpStatus(req.params.businessId, 'skip');
  if (!found) return res.status(404).json({ error: 'Business not found' });
  res.json({ ok: true });
});

router.post('/analyze', async (req, res) => {
  const { businessId } = req.body as { businessId?: unknown };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }

  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });

  if (!row.website) {
    return res.json({
      loadedSuccessfully: false, error: 'no_website',
      hasViewportMeta: false, hasContactForm: false, hasOnlineBooking: false,
      hasWhatsappLink: false, hasSSL: false, pageTitle: null,
      metaDescription: null, hasMenuOrServices: false, finalUrl: null,
    } satisfies WebsiteAnalysis);
  }

  const result = await analyzeWebsite(row.website);
  if (isPersistableWebsiteAnalysis(result)) {
    saveOutreachAnalysis(businessId, serializeWebsiteAnalysis(result));
  }
  res.json(result);
});

router.post('/premium-analyze', (req, res) => {
  const { businessId } = req.body as { businessId?: unknown };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }
  if (!env.PLAYWRIGHT_WS_URL) {
    return res.status(503).json({ error: 'premium_analysis_not_configured' });
  }
  if (!getBusinessWebsite(businessId)) {
    return res.status(404).json({ error: 'Business not found' });
  }
  const result = requestPremiumAnalysis(businessId);
  res.status(202).json(result);
});

router.get('/premium/:businessId', (req, res) => {
  const row = getLatestPremiumAnalysis(req.params.businessId);
  if (!row) return res.json({ analysis: null });
  res.json({
    analysis: {
      id: row.id,
      businessId: row.businessId,
      status: row.status,
      renderOutcome: row.renderOutcome,
      finalUrl: row.finalUrl,
      signals: row.signalsJson ? JSON.parse(row.signalsJson) : null,
      cookieWall: row.cookieWall === 1,
      consoleErrors: row.consoleErrorsJson ? JSON.parse(row.consoleErrorsJson) : [],
      desktopScreenshotPath: row.desktopScreenshotPath,
      mobileScreenshotPath: row.mobileScreenshotPath,
      htmlPath: row.htmlPath,
      networkLogPath: row.networkLogPath,
      detectedSigs: row.detectedSigsJson ? JSON.parse(row.detectedSigsJson) : [],
      psi: row.psiJson ? (JSON.parse(row.psiJson) as PsiData) : null,
      vision: row.visionJson ? (JSON.parse(row.visionJson) as VisionResult) : null,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    },
  });
});

router.post('/generate', async (req, res) => {
  const { businessId, analysis } = req.body as { businessId?: unknown; analysis?: WebsiteAnalysis };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }

  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });

  const premiumRow = getLatestPremiumAnalysis(businessId);
  const detectedSigs: DetectedSig[] | undefined =
    premiumRow?.detectedSigsJson ? JSON.parse(premiumRow.detectedSigsJson) : undefined;
  const psiData: PsiData | null =
    premiumRow?.psiJson ? (JSON.parse(premiumRow.psiJson) as PsiData) : null;
  const visionResult: VisionResult | null =
    premiumRow?.visionJson ? (JSON.parse(premiumRow.visionJson) as VisionResult) : null;
  const signalMap: SignalMap | undefined =
    premiumRow?.signalsJson ? (JSON.parse(premiumRow.signalsJson) as SignalMap) : undefined;

  const business = {
    name: row.name,
    category: row.category ?? null,
    website: row.website ?? null,
    locCountry: row.locCountry ?? null,
    locNeighbourhood: row.locNeighbourhood ?? null,
    rating: row.rating ?? null,
    reviewCount: row.reviewCount ?? null,
  };

  try {
    if (isPersistableWebsiteAnalysis(analysis)) {
      saveOutreachAnalysis(businessId, serializeWebsiteAnalysis(analysis));
    }

    const { subject, body, topGap, verdict } = await composeVerifiedEmail(
      business, analysis, detectedSigs, psiData, visionResult, signalMap, businessId,
    );

    upsertDraft(businessId, subject, body, true);
    saveDraftTopGap(businessId, topGap);
    saveDraftVerification(businessId, JSON.stringify(verdict));

    res.json({
      subject,
      body,
      topGap,
      verification: {
        status: verdict.status,
        violations: verdict.claims.filter(c => !c.supported),
      },
    });
  } catch (err) {
    sendGeminiError(res, err);
  }
});

router.post('/send', async (req, res) => {
  const { businessId, subject, body } = req.body as { businessId?: unknown; subject?: unknown; body?: unknown };
  const isOverride = req.query.override === 'true';

  if (typeof businessId !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ error: 'businessId, subject, and body are required strings' });
  }

  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });

  // Verification gate (shared with the scheduled-send worker via evaluateSendGate).
  // isAiDraft=false drafts (user-edited) are human-reviewed and pass. A human may
  // override a held verdict with ?override=true — the worker never can.
  const draft = getDraft(businessId);
  const gate = evaluateSendGate(draft);
  if (!gate.allowed && !isOverride) {
    return res.status(409).json({ error: 'verification_held', reason: gate.reason, violations: gate.violations ?? [] });
  }
  if (isOverride && !gate.allowed && draft?.isAiDraft) {
    // Record the server-side bypass before the draft is deleted (only when a
    // stored verdict exists; an unverified draft has nothing to override-stamp).
    const verdict = parseVerdict(draft);
    if (verdict) {
      const overrideRecord: VerificationResult = {
        ...verdict,
        status: 'override_sent',
        overrideAt: new Date().toISOString(),
        overriddenStatus: verdict.status,
      };
      saveDraftVerification(businessId, JSON.stringify(overrideRecord));
      console.warn(`[verification] override used by user for businessId=${businessId}, original status=${verdict.status}`);
    }
  }

  // Slice 0025: same selector as the batch gate / scheduled worker — the manual
  // Send button must transmit to the same best-reachable address the queue showed.
  const to = await selectBestEmail(businessId);
  if (!to || !validateEmail(to)) {
    return res.status(422).json({ error: 'no_valid_email', field: 'emailsJson' });
  }

  const result = await sendEmail(to, subject, body, businessId, row.locCountry ?? null, isOverride);
  if (!result.success) {
    return res.status(result.error === 'Daily limit reached' ? 429 : 502).json(result);
  }
  try {
    const draft = getDraft(businessId);
    saveEmailExample({
      businessId,
      category: row.category ?? null,
      topGap: draft?.topGap ?? null,
      neighbourhood: row.locNeighbourhood ?? null,
      subject,
      body,
      // row was read before sendEmail flipped the status: 'contacted' means this send is a follow-up
      kind: row.outreachStatus === 'contacted' ? 'followup' : 'initial',
    });
  } catch (err) {
    console.error('[outreach/send] saveEmailExample failed:', err);
  }
  deleteDraft(businessId);
  const supersededCount = supersedeScheduledSendsForBusiness(businessId);
  if (supersededCount > 0) {
    console.log(`[scheduler] superseded ${supersededCount} rows business=${businessId} reason=manual-send`);
  }
  res.json(result);
});

router.put('/draft', (req, res) => {
  const { businessId, subject, body, isAiDraft, topGap } = req.body as {
    businessId?: unknown; subject?: unknown; body?: unknown; isAiDraft?: unknown; topGap?: unknown;
  };
  if (typeof businessId !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ error: 'businessId, subject, and body required' });
  }
  upsertDraft(businessId, subject, body, isAiDraft === true);
  if ('topGap' in req.body) {
    saveDraftTopGap(businessId, typeof topGap === 'string' ? topGap : null);
  }
  res.json({ ok: true });
});

router.get('/draft/:businessId', (req, res) => {
  res.json({ draft: getDraft(req.params.businessId) });
});

router.get('/signature', (_req, res) => {
  res.json({ html: signatureHtml });
});

router.post('/check-replies', async (_req, res) => {
  try {
    const result = await checkReplies();
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'not_configured') {
      return res.status(409).json({ error: 'not_configured' });
    }
    res.status(502).json({ error: message });
  }
});

router.get('/stats', (_req, res) => {
  const sent_today = getDailySendCount();
  const total_contacted = db.select({ n: sql<number>`count(*)` })
    .from(businesses).where(eq(businesses.outreachStatus, 'contacted')).get()?.n ?? 0;
  res.json({ sent_today, remaining: DAILY_CAP - sent_today, total_contacted });
});

// ── Scheduled sends ───────────────────────────────────────────────────────────

// Schedule an existing draft. sendAt is a TRUE-UTC ISO string the client computed
// from the BA-wall-clock picker; optimalWindow resolves the next type-aware slot.
// The draft is NOT snapshotted — the worker re-reads it live and re-gates at fire
// time (single source of truth). A held/unverified draft may be scheduled; the gate
// holds it at fire time.
router.post('/schedule', (req, res) => {
  const { businessId, sendAt, optimalWindow } = req.body as {
    businessId?: unknown; sendAt?: unknown; optimalWindow?: unknown;
  };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId is required' });
  }
  const row = getOutreachSendRow(businessId);
  if (!row) return res.status(404).json({ error: 'Business not found' });

  const type = resolveBusinessType(row.category);
  let scheduledAtUtc: string;
  if (optimalWindow === true) {
    scheduledAtUtc = new Date(nextOptimalWindowUtc(Date.now(), type)).toISOString();
  } else {
    if (typeof sendAt !== 'string') {
      return res.status(400).json({ error: 'sendAt (UTC ISO) or optimalWindow is required' });
    }
    const t = new Date(sendAt).getTime();
    if (Number.isNaN(t)) return res.status(400).json({ error: 'sendAt is not a valid date' });
    scheduledAtUtc = new Date(t).toISOString();
  }

  const created = createScheduledSend({
    businessId,
    scheduledAtUtc,
    businessType: type,
    windowLabel: describeWindow(type),
    origin: 'manual',
  });
  res.json({ scheduled: created });
});

router.get('/scheduled', (_req, res) => {
  res.json({ scheduled: listUpcomingScheduledSends() });
});

router.delete('/schedule/:id', (req, res) => {
  const ok = cancelScheduledSend(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found or not cancelable' });
  res.json({ canceled: true });
});

router.patch('/schedule/:id', (req, res) => {
  const { sendAt } = req.body as { sendAt?: unknown };
  if (typeof sendAt !== 'string') return res.status(400).json({ error: 'sendAt (UTC ISO) is required' });
  const t = new Date(sendAt).getTime();
  if (Number.isNaN(t)) return res.status(400).json({ error: 'sendAt is not a valid date' });
  const ok = rescheduleScheduledSend(req.params.id, new Date(t).toISOString());
  if (!ok) return res.status(404).json({ error: 'not found or not reschedulable' });
  res.json({ rescheduled: true });
});

router.get('/schedule/status/:businessId', (req, res) => {
  const row = getMostRecentScheduledSend(req.params.businessId);
  res.json({ row: row ?? null });
});

export default router;
