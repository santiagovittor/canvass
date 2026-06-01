import { Router } from 'express';
import { db } from '../db';
import { businesses } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { getOutreachLeads, getDailySendCount, validateEmail, parseEmails, upsertDraft, getDraft, deleteDraft, getDistinctOutreachCategories, saveDraftTopGap, saveEmailExample } from '../db';
import { composeEmail } from '../services/geminiComposer';
import { sendEmail, signatureHtml } from '../services/emailSender';
import { analyzeWebsite } from '../services/websiteAnalyzer';
import type { WebsiteAnalysis } from '../services/websiteAnalyzer';

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

router.post('/generate', async (req, res) => {
  const { businessId, analysis } = req.body as { businessId?: unknown; analysis?: WebsiteAnalysis };
  if (typeof businessId !== 'string') {
    return res.status(400).json({ error: 'businessId required' });
  }

  const row = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!row) return res.status(404).json({ error: 'Business not found' });

  try {
    const result = await composeEmail({
      name: row.name,
      category: row.category ?? null,
      website: row.website ?? null,
      locCountry: row.locCountry ?? null,
      locNeighbourhood: row.locNeighbourhood ?? null,
      rating: row.rating ?? null,
      reviewCount: row.reviewCount ?? null,
    }, analysis);
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
  console.error('[outreach/send] raw emailsJson:', row.emailsJson, '→ parsed:', to);
  if (!to || !validateEmail(to)) {
    return res.status(422).json({ error: 'no_valid_email', field: 'emailsJson' });
  }

  const result = await sendEmail(to, subject, body, businessId);
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

router.get('/stats', (_req, res) => {
  const sent_today = getDailySendCount();
  const total_contacted = db.select({ n: sql<number>`count(*)` })
    .from(businesses).where(eq(businesses.outreachStatus, 'contacted')).get()?.n ?? 0;
  res.json({ sent_today, remaining: DAILY_CAP - sent_today, total_contacted });
});

export default router;
