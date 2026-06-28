import fs from 'fs';
import path from 'path';
import { dataDir } from '../db';
import {
  completePremiumAnalysis, getBusinessWebsite,
  type PremiumAnalysisRow, type SignalMap, type DetectedSig,
} from '../db/premium';
import { SIGNATURES } from '../data/signatureLibrary';
import { broadcast } from '../sse';
import { renderSite, type RenderResult } from './playwrightRenderer';
import {
  analyzeWebsite, normalizeUrl, stripScriptsAndStyles, findContactForm,
  VIEWPORT_RX, BOOKING_RX, WHATSAPP_RX, MENU_RX, CHAT_RX, ANALYTICS_RX,
  TEL_RX, STRUCTURED_DATA_RX, OPEN_GRAPH_RX, TESTIMONIALS_RX,
  VISIBLE_EMAIL_RX, BLOG_RX, FAVICON_RX, NEWSLETTER_RX,
  type WebsiteAnalysis,
} from './websiteAnalyzer';
import { env } from '../env';
import { GeminiRpdExhausted } from './geminiRateLimiter';
import { fetchPsi } from './psiClient';
import { getCachedPsi, upsertPsiCache, type PsiData } from '../db/psiCache';
import { runVision, type VisionResult } from './visionClient';
import { getRubric } from '../data/visionRubrics';
import { withAnalysis, stage } from './stageTracker';

export type { TriState, DetectorKind, Signal, SignalEvidence, SignalMap } from '../db/premium';

const SNIPPET_CONTEXT = 120;

// THE gate for ABSENT_VERIFIED. The vision pass (slice 4) is the only caller
// that can pass visionAbsent === true, so until it ships this always returns
// false — by design: nothing may be claimed verified-absent without it.
function verifyAbsent(c: {
  renderOk: boolean;
  domAbsent: boolean;
  networkAbsent: boolean;
  visionAbsent: boolean | null;
}): boolean {
  return c.renderOk && c.domAbsent && c.networkAbsent && c.visionAbsent === true;
}

// Applies vision pass results to signals. ABSENT_VERIFIED requires all four
// detectors to have actually run and found nothing — derived from the signal's
// real state + checkedBy, not hardcoded. PSI mobileFriendly cross-checks
// hasViewportMeta: if PSI reports the page as mobile-friendly, the viewport meta
// IS present and we must not claim ABSENT_VERIFIED.
function applyVisionUpgrades(
  signals: SignalMap,
  vision: VisionResult,
  renderOk: boolean,
  psiData: PsiData | null,
): void {
  // hasViewportMeta — the one ABSENT_VERIFIED-eligible signal.
  // state === UNKNOWN means dom + network both checked and found nothing.
  // PSI mobileFriendly === true contradicts absence; stay UNKNOWN if they disagree.
  const vp = signals.hasViewportMeta;
  if (
    vp &&
    vp.state === 'UNKNOWN' &&
    vision.mobileResponsive === 'no' &&
    psiData?.mobileFriendly !== true
  ) {
    // Derive actual absent flags from what the signal recorded
    const domAbsent = vp.checkedBy.includes('dom');     // dom ran; UNKNOWN ⟹ not found
    const networkAbsent = vp.checkedBy.includes('network'); // network ran; UNKNOWN ⟹ not found
    if (verifyAbsent({ renderOk, domAbsent, networkAbsent, visionAbsent: true })) {
      signals.hasViewportMeta = {
        state: 'ABSENT_VERIFIED',
        evidence: {
          kind: 'vision',
          value: 'vision: site not mobile-responsive on screenshot; no viewport meta in DOM or network; PSI did not report mobileFriendly',
        },
        checkedBy: [...vp.checkedBy, 'vision'],
      };
    }
  }

  // Widget signals: UNKNOWN → PRESENT when vision spots something DOM/network missed.
  // Live chat can become ABSENT_VERIFIED only through DOM + network + vision agreement.
  // WhatsApp and booking stay UNKNOWN-only on absence.
  if (signals.hasWhatsappLink?.state === 'UNKNOWN' && vision.widgetVisibility.whatsapp === 'yes') {
    signals.hasWhatsappLink = {
      state: 'PRESENT',
      evidence: { kind: 'vision', value: 'WhatsApp button visible in screenshot' },
      checkedBy: [...(signals.hasWhatsappLink.checkedBy), 'vision'],
    };
  }
  if (signals.hasLiveChatWidget?.state === 'UNKNOWN' && vision.widgetVisibility.chat === 'yes') {
    signals.hasLiveChatWidget = {
      state: 'PRESENT',
      evidence: { kind: 'vision', value: 'chat widget visible in screenshot' },
      checkedBy: [...(signals.hasLiveChatWidget.checkedBy), 'vision'],
    };
  }
  if (signals.hasLiveChatWidget?.state === 'UNKNOWN' && vision.widgetVisibility.chat === 'no') {
    const chat = signals.hasLiveChatWidget;
    const domAbsent = chat.checkedBy.includes('dom');
    const networkAbsent = chat.checkedBy.includes('network');
    if (verifyAbsent({ renderOk, domAbsent, networkAbsent, visionAbsent: true })) {
      signals.hasLiveChatWidget = {
        state: 'ABSENT_VERIFIED',
        evidence: { kind: 'vision', value: 'no chat/assistant widget in DOM, network, or screenshot' },
        checkedBy: [...chat.checkedBy, 'vision'],
      };
    }
  }
  if (signals.hasOnlineBooking?.state === 'UNKNOWN' && vision.widgetVisibility.booking === 'yes') {
    signals.hasOnlineBooking = {
      state: 'PRESENT',
      evidence: { kind: 'vision', value: 'booking widget or button visible in screenshot' },
      checkedBy: [...(signals.hasOnlineBooking.checkedBy), 'vision'],
    };
  }
}

// Boolean signals shared with the raw-fetch analyzer; keys match WebsiteAnalysis.
// `source` picks what the DOM regex runs against: full rendered HTML or
// visible text (scripts/styles stripped, lowercased) — mirrors websiteAnalyzer.
const DETECTORS: { key: string; dom?: RegExp; network?: RegExp; source: 'html' | 'visible' }[] = [
  { key: 'hasViewportMeta', dom: VIEWPORT_RX, source: 'html' },
  { key: 'hasOnlineBooking', dom: BOOKING_RX, network: BOOKING_RX, source: 'html' },
  { key: 'hasWhatsappLink', dom: WHATSAPP_RX, network: WHATSAPP_RX, source: 'html' },
  { key: 'hasMenuOrServices', dom: MENU_RX, source: 'html' },
  { key: 'hasLiveChatWidget', dom: CHAT_RX, network: CHAT_RX, source: 'html' },
  { key: 'hasAnalytics', dom: ANALYTICS_RX, network: ANALYTICS_RX, source: 'html' },
  { key: 'hasTelLink', dom: TEL_RX, source: 'html' },
  { key: 'hasStructuredData', dom: STRUCTURED_DATA_RX, source: 'html' },
  { key: 'hasOpenGraph', dom: OPEN_GRAPH_RX, source: 'html' },
  { key: 'hasTestimonials', dom: TESTIMONIALS_RX, source: 'visible' },
  { key: 'hasVisibleEmail', dom: VISIBLE_EMAIL_RX, source: 'visible' },
  { key: 'hasBlog', dom: BLOG_RX, source: 'visible' },
  { key: 'hasFavicon', dom: FAVICON_RX, source: 'html' },
  { key: 'hasNewsletterForm', dom: NEWSLETTER_RX, network: NEWSLETTER_RX, source: 'html' },
];

const RAW_FETCH_BOOLEAN_KEYS = [
  ...DETECTORS.map(d => d.key),
  'hasContactForm', 'hasSSL', 'hasMetaPixel',
] as const;

// Raw-fetch reinterpretation: a positive is real evidence, a negative proves
// nothing (JS-injected widgets are invisible to a raw fetch). Never ABSENT_VERIFIED.
export function rawFetchToTriState(a: WebsiteAnalysis): SignalMap {
  const signals: SignalMap = {};
  for (const key of RAW_FETCH_BOOLEAN_KEYS) {
    const value = (a as unknown as Record<string, unknown>)[key];
    if (a.loadedSuccessfully && value === true) {
      signals[key] = {
        state: 'PRESENT',
        evidence: { kind: 'raw_fetch', value: 'detected in raw HTML fetch' },
        checkedBy: ['raw_fetch'],
      };
    } else {
      signals[key] = { state: 'UNKNOWN', checkedBy: a.loadedSuccessfully ? ['raw_fetch'] : [] };
    }
  }
  return signals;
}

function snippetAround(text: string, rx: RegExp): string | null {
  const m = rx.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - SNIPPET_CONTEXT);
  const end = Math.min(text.length, m.index + m[0].length + SNIPPET_CONTEXT);
  return text.slice(start, end);
}

function detectSignals(html: string, networkUrls: string[], finalUrl: string): SignalMap {
  const visible = stripScriptsAndStyles(html).toLowerCase();
  const signals: SignalMap = {};

  for (const d of DETECTORS) {
    const domText = d.source === 'visible' ? visible : html;
    const domSnippet = d.dom ? snippetAround(domText, d.dom) : null;
    if (domSnippet) {
      signals[d.key] = {
        state: 'PRESENT',
        evidence: { kind: 'dom', value: domSnippet },
        checkedBy: ['dom', 'network'],
      };
      continue;
    }
    const networkHit = d.network ? networkUrls.find(u => d.network!.test(u)) : undefined;
    if (networkHit) {
      signals[d.key] = {
        state: 'PRESENT',
        evidence: { kind: 'network', value: networkHit },
        checkedBy: ['dom', 'network'],
      };
      continue;
    }
    // Render OK + DOM absent + network absent, but no vision verdict yet → UNKNOWN
    signals[d.key] = {
      state: verifyAbsent({ renderOk: true, domAbsent: true, networkAbsent: true, visionAbsent: null })
        ? 'ABSENT_VERIFIED'
        : 'UNKNOWN',
      checkedBy: ['dom', 'network'],
    };
  }

  const form = findContactForm(html);
  signals.hasContactForm = form
    ? {
        state: 'PRESENT',
        evidence: { kind: 'dom', value: form.slice(0, SNIPPET_CONTEXT * 2 + 50) },
        checkedBy: ['dom', 'network'],
      }
    : { state: 'UNKNOWN', checkedBy: ['dom', 'network'] };

  // SSL is a protocol fact observed directly on a successful render — not a
  // visibility question the vision pass could answer. http here is definitive.
  signals.hasSSL = finalUrl.startsWith('https://')
    ? { state: 'PRESENT', evidence: { kind: 'network', value: finalUrl }, checkedBy: ['network'] }
    : { state: 'ABSENT_VERIFIED', evidence: { kind: 'network', value: finalUrl }, checkedBy: ['network'] };

  const metaPixel = detectMetaPixel(html, networkUrls);
  signals.hasMetaPixel = metaPixel
    ? {
        state: 'PRESENT',
        evidence: { kind: metaPixel.evidenceKind, value: metaPixel.evidenceValue },
        checkedBy: ['dom', 'network'],
      }
    : { state: 'UNKNOWN', checkedBy: ['dom', 'network'] };

  return signals;
}

function detectMetaPixel(html: string, networkUrls: string[]): {
  evidenceKind: 'dom' | 'network';
  evidenceValue: string;
} | null {
  const markers: string[] = [];
  const pixelIds: string[] = [];
  let evidenceKind: 'dom' | 'network' = 'dom';

  if (networkUrls.some(u => /connect\.facebook\.net.*fbevents/i.test(u))) {
    markers.push('network:fbevents.js');
    evidenceKind = 'network';
  }

  for (const url of networkUrls) {
    const match = /facebook\.com\/tr\?(?:[^#]*&)?id=([^&#]+)/i.exec(url);
    if (!match) continue;
    markers.push('network:facebook_tr');
    pixelIds.push(decodeURIComponent(match[1]));
    evidenceKind = 'network';
  }

  for (const match of html.matchAll(/fbq\s*\(\s*['"]init['"]\s*,\s*['"]([^'"]+)['"]/gi)) {
    markers.push('dom:fbq_init');
    pixelIds.push(match[1]);
  }

  for (const match of html.matchAll(/<noscript[\s\S]*?facebook\.com\/tr\?[\s\S]*?\bid=([^&"'<>]+)/gi)) {
    markers.push('dom:noscript_tr');
    pixelIds.push(decodeURIComponent(match[1]));
  }

  if (markers.length === 0) return null;

  const uniqueMarkers = [...new Set(markers)];
  const uniqueIds = [...new Set(pixelIds.filter(Boolean))];
  return {
    evidenceKind,
    evidenceValue: `markers=[${uniqueMarkers.join(',')}]; pixelId=${uniqueIds[0] ?? 'unknown'}`,
  };
}

export const detectSignalsForTest = detectSignals;
export const applyVisionUpgradesForTest = applyVisionUpgrades;

function scanSignatures(
  html: string,
  networkUrls: string[],
): { detectedSigs: DetectedSig[]; signalUpgrades: Partial<SignalMap> } {
  const detectedSigs: DetectedSig[] = [];
  const signalUpgrades: Partial<SignalMap> = {};

  for (const sig of SIGNATURES) {
    let evidence: DetectedSig['evidence'] | null = null;

    // Network match preferred (higher signal, exact URL as evidence)
    if (sig.network) {
      const hit = networkUrls.find(u => sig.network!.test(u));
      if (hit) evidence = { kind: 'network', value: hit };
    }

    // DOM match as fallback
    if (!evidence && sig.dom) {
      const snippet = snippetAround(html, sig.dom);
      if (snippet) evidence = { kind: 'dom', value: snippet };
    }

    if (!evidence) continue;

    detectedSigs.push({ id: sig.id, name: sig.name, category: sig.category, evidence });

    if (sig.signalKey) {
      signalUpgrades[sig.signalKey] = {
        state: 'PRESENT',
        evidence: { kind: evidence.kind, value: evidence.value },
        checkedBy: ['dom', 'network'],
      };
    }
  }

  return { detectedSigs, signalUpgrades };
}

function allUnknown(): SignalMap {
  const signals: SignalMap = {};
  for (const key of RAW_FETCH_BOOLEAN_KEYS) {
    signals[key] = { state: 'UNKNOWN', checkedBy: [] };
  }
  return signals;
}

function writeBundle(businessId: string, runId: string, r: RenderResult): {
  desktop?: string; mobile?: string; html?: string; network?: string;
} {
  const relDir = path.join('premium', businessId, runId);
  const absDir = path.join(dataDir, relDir);
  fs.mkdirSync(absDir, { recursive: true });

  const paths: { desktop?: string; mobile?: string; html?: string; network?: string } = {};
  if (r.html !== null) {
    fs.writeFileSync(path.join(absDir, 'rendered.html'), r.html);
    paths.html = path.join(relDir, 'rendered.html');
  }
  fs.writeFileSync(path.join(absDir, 'network.json'), JSON.stringify(r.networkUrls, null, 2));
  paths.network = path.join(relDir, 'network.json');
  fs.writeFileSync(path.join(absDir, 'console.json'), JSON.stringify(r.consoleErrors, null, 2));
  if (r.desktopScreenshot) {
    fs.writeFileSync(path.join(absDir, 'desktop.png'), r.desktopScreenshot);
    paths.desktop = path.join(relDir, 'desktop.png');
  }
  if (r.mobileScreenshot) {
    fs.writeFileSync(path.join(absDir, 'mobile.png'), r.mobileScreenshot);
    paths.mobile = path.join(relDir, 'mobile.png');
  }
  return paths;
}

async function runPsi(finalUrl: string): Promise<PsiData | null> {
  if (!env.PAGESPEED_API_KEY) return null;
  const cached = getCachedPsi(finalUrl);
  if (cached) {
    console.log(`[psi] cache hit for ${finalUrl} (fetchedAt: ${cached.fetchedAt})`);
    return cached;
  }
  const result = await fetchPsi(finalUrl, env.PAGESPEED_API_KEY);
  if (result) {
    upsertPsiCache(finalUrl, result);
    console.log(`[psi] fetched for ${finalUrl}: score=${result.mobileScore}`);
    return result;
  }
  // Cache the degraded result (all-null) so the next scan within 24h fast-degrades
  // instead of re-burning the 60s call. fetchPsi already logged the reason.
  const degraded: PsiData = {
    mobileScore: null, lcp: null, tbt: null, tti: null,
    mobileFriendly: null, fetchedAt: new Date().toISOString(),
  };
  upsertPsiCache(finalUrl, degraded);
  return null;
}

export async function runPremiumAnalysis(row: PremiumAnalysisRow): Promise<void> {
  await withAnalysis(row.businessId, 'premium', () => runPremiumAnalysisInner(row));
}

async function runPremiumAnalysisInner(row: PremiumAnalysisRow): Promise<void> {
  const biz = getBusinessWebsite(row.businessId);

  if (!biz || !biz.website) {
    completePremiumAnalysis(row.id, {
      status: 'done', renderOutcome: 'no_website', finalUrl: null,
      signals: {}, cookieWall: false, consoleErrors: [], paths: {}, detectedSigs: [],
    });
    broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'done', renderOutcome: 'no_website' });
    return;
  }

  const website = biz.website;
  const render = await stage('render', () => renderSite(normalizeUrl(website)));

  if (render.outcome !== 'ok') {
    // Failed render is never a negative: everything UNKNOWN, then keep any
    // raw-fetch POSITIVES (a raw-fetch PRESENT is still true if Chromium choked).
    // Exception: redirect_social — the raw fetch lands on the same social page,
    // so its positives would be Facebook's/Instagram's DOM, not the business's.
    const signals = allUnknown();
    if (render.outcome !== 'redirect_social') {
      try {
        const rawSignals = rawFetchToTriState(await analyzeWebsite(biz.website));
        for (const [key, sig] of Object.entries(rawSignals)) {
          if (sig.state === 'PRESENT') signals[key] = sig;
        }
      } catch {
        // raw fetch is best-effort enrichment here
      }
    }

    const status = render.outcome === 'browser_error' ? 'failed' : 'done';
    completePremiumAnalysis(row.id, {
      status, renderOutcome: render.outcome, finalUrl: render.finalUrl,
      signals, cookieWall: render.cookieWallDetected, consoleErrors: render.consoleErrors,
      paths: {}, detectedSigs: [], errorMessage: render.errorMessage,
    });
    broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status, renderOutcome: render.outcome });
    return;
  }

  const paths = writeBundle(row.businessId, row.id, render);
  const signals = await stage('signatures', async () => {
    const signals = detectSignals(render.html!, render.networkUrls, render.finalUrl!);
    const { detectedSigs, signalUpgrades } = scanSignatures(render.html!, render.networkUrls);
    // Upgrade UNKNOWN signals where scanner found evidence (PRESENT-grade detections only)
    for (const [key, upgrade] of Object.entries(signalUpgrades)) {
      if (upgrade && signals[key]?.state === 'UNKNOWN') signals[key] = upgrade;
    }
    return { signals, detectedSigs };
  });
  const detectedSigs = signals.detectedSigs;
  const signalMap = signals.signals;

  // PSI: only on ok renders with a real finalUrl. Non-ok path above already returned.
  let psiJson: string | null = null;
  try {
    const psiData = await stage('psi', () => runPsi(render.finalUrl!));
    if (psiData) psiJson = JSON.stringify(psiData);
  } catch (err) {
    console.error('[psi] unexpected error, skipping:', err);
  }

  // Vision pass — ok render only, screenshot guard, degrade cleanly on any failure
  let visionJson: string | null = null;
  if (render.desktopScreenshot) {
    try {
      const rubric = getRubric(biz.category ?? null);
      const visionResult: VisionResult | null = await stage('vision', () => runVision(
        render.desktopScreenshot!,
        render.mobileScreenshot,
        biz.category ?? null,
        rubric,
      ));
      if (visionResult) {
        const psiForCrossCheck: PsiData | null = psiJson ? JSON.parse(psiJson) : null;
        applyVisionUpgrades(signalMap, visionResult, true, psiForCrossCheck);
        visionJson = JSON.stringify(visionResult);
        console.log(`[vision] ok for ${biz.website ?? row.businessId}`);
      }
    } catch (err) {
      if (err instanceof GeminiRpdExhausted) throw err; // budget cap: propagate to queue/batch, leave lead resumable
      console.error('[vision] unexpected error, skipping:', err);
    }
  }

  completePremiumAnalysis(row.id, {
    status: 'done', renderOutcome: 'ok', finalUrl: render.finalUrl,
    signals: signalMap, cookieWall: render.cookieWallDetected, consoleErrors: render.consoleErrors,
    paths, detectedSigs, psiJson, visionJson,
  });
  broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'done', renderOutcome: 'ok' });
}
