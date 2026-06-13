import { Router } from 'express';
import { db } from '../db';
import { businesses } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { getOutreachLeads, getDailySendCount, validateEmail, parseEmails, upsertDraft, getDraft, deleteDraft, getDistinctOutreachCategories, saveDraftTopGap, saveEmailExample, getFollowUpLeads, getRepliedLeads, setFollowUpStatus, getLatestSentEmail, getLastSentAt, hasOpens } from '../db';
import { composeEmail, composeFollowUp } from '../services/geminiComposer';
import { sendEmail, signatureHtml } from '../services/emailSender';
import { checkReplies } from '../services/replyChecker';
import { analyzeWebsite } from '../services/websiteAnalyzer';
import type { WebsiteAnalysis } from '../services/websiteAnalyzer';
import { requestPremiumAnalysis } from '../services/premiumAnalysisQueue';
import { getBusinessWebsite, getLatestPremiumAnalysis, type DetectedSig } from '../db/premium';
import { env } from '../env';
import type { PsiData } from '../db/psiCache';
import { UTC_MINUS_3_OFFSET_MS } from '../util/time';

const DAILY_CAP = 30;

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

router.get('/follow-ups', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const days = Math.max(1, parseInt(String(req.query.days ?? '4'), 10) || 4);
  res.json(getFollowUpLeads(page, 25, days));
});

router.get('/replied', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  res.json(getRepliedLeads(page, 25));
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
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
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

  try {
    const result = await composeEmail({
      name: row.name,
      category: row.category ?? null,
      website: row.website ?? null,
      locCountry: row.locCountry ?? null,
      locNeighbourhood: row.locNeighbourhood ?? null,
      rating: row.rating ?? null,
      reviewCount: row.reviewCount ?? null,
    }, analysis, undefined, detectedSigs, psiData);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

router.post('/send', async (req, res) => {
  const { businessId, subject, body } = req.body as { businessId?: unknown; subject?: unknown; body?: unknown };

  if (typeof businessId !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ error: 'businessId, subject, and body are required strings' });
  }

  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });

  const emails = parseEmails(row.emailsJson ?? null);
  const to = emails[0];
  if (!to || !validateEmail(to)) {
    return res.status(422).json({ error: 'no_valid_email', field: 'emailsJson' });
  }

  const result = await sendEmail(to, subject, body, businessId, row.locCountry ?? null);
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

export default router;
