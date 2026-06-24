import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { env } from '../env';

export interface RenderResult {
  outcome: 'ok' | 'timeout' | 'ssl_error' | 'dns_error' | 'http_error' | 'redirect_social' | 'browser_error';
  finalUrl: string | null;
  html: string | null;
  networkUrls: string[];
  consoleErrors: string[];
  desktopScreenshot: Buffer | null;
  mobileScreenshot: Buffer | null;
  cookieWallDetected: boolean;
  errorMessage?: string;
}

const MAX_NETWORK_URLS = 1000;
const MAX_CONSOLE_ERRORS = 50;
const NETWORK_SETTLE_TIMEOUT_MS = 8000;
const MOBILE_TIMEOUT_MS = 15000;
const COOKIE_CLICK_BUDGET_MS = 1500;

// The "site" redirected to a social profile — signals must not derive from
// Facebook's/Instagram's DOM, so the render is reported as non-ok.
const SOCIAL_HOST_RX = /(facebook|instagram|wa\.me|whatsapp|linktr\.ee|tiktok)\./i;

const DESKTOP_VIEWPORT = { width: 1366, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function classifyError(err: unknown): { outcome: RenderResult['outcome']; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (/Timeout \d+ms exceeded|TimeoutError/i.test(message)) return { outcome: 'timeout', message };
  if (/ERR_CERT|ERR_SSL|SSL_ERROR/i.test(message)) return { outcome: 'ssl_error', message };
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/i.test(message)) {
    return { outcome: 'dns_error', message };
  }
  return { outcome: 'browser_error', message };
}

// Best-effort cookie-wall dismissal: click the first visible consent button
// within a small budget. Never blocks, never fails the render.
async function dismissCookieWall(page: Page): Promise<boolean> {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button:has-text("Aceptar")',
    'button:has-text("Accept")',
    '[id*="accept"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 300 })) {
        await btn.click({ timeout: COOKIE_CLICK_BUDGET_MS });
        await page.waitForTimeout(500);
        return true;
      }
    } catch {
      // not present / not clickable — try next
    }
  }
  return false;
}

export async function renderSite(url: string): Promise<RenderResult> {
  if (!env.PLAYWRIGHT_WS_URL) {
    return {
      outcome: 'browser_error', finalUrl: null, html: null, networkUrls: [],
      consoleErrors: [], desktopScreenshot: null, mobileScreenshot: null,
      cookieWallDetected: false, errorMessage: 'PLAYWRIGHT_WS_URL not configured',
    };
  }

  let browser: Browser | null = null;
  const networkUrls = new Set<string>();
  const consoleErrors: string[] = [];

  try {
    browser = await chromium.connect(env.PLAYWRIGHT_WS_URL);
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const page = await context.newPage();

    page.on('request', req => {
      if (networkUrls.size < MAX_NETWORK_URLS) networkUrls.add(req.url());
    });
    page.on('console', msg => {
      if (msg.type() === 'error' && consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => {
      if (consoleErrors.length < MAX_CONSOLE_ERRORS) consoleErrors.push(err.message);
    });

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: env.PREMIUM_RENDER_TIMEOUT_MS,
      });
    } catch (err) {
      const { outcome, message } = classifyError(err);
      return {
        outcome, finalUrl: null, html: null, networkUrls: [...networkUrls],
        consoleErrors, desktopScreenshot: null, mobileScreenshot: null,
        cookieWallDetected: false, errorMessage: message,
      };
    }

    // Chat widgets that poll forever must not fail the render
    await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_TIMEOUT_MS }).catch(() => {});

    const finalUrl = page.url();
    const status = response?.status() ?? 0;

    if (status >= 400) {
      return {
        outcome: 'http_error', finalUrl, html: null, networkUrls: [...networkUrls],
        consoleErrors, desktopScreenshot: null, mobileScreenshot: null,
        cookieWallDetected: false, errorMessage: `HTTP ${status}`,
      };
    }

    if (SOCIAL_HOST_RX.test(new URL(finalUrl).hostname)) {
      return {
        outcome: 'redirect_social', finalUrl, html: null, networkUrls: [...networkUrls],
        consoleErrors, desktopScreenshot: null, mobileScreenshot: null,
        cookieWallDetected: false, errorMessage: `redirected to ${new URL(finalUrl).hostname}`,
      };
    }

    const cookieWallDetected = await dismissCookieWall(page);
    const html = await page.content();
    // Viewport-only (above-the-fold), NOT fullPage. A full-page PNG of a long site tiles
    // into thousands of Gemini image tokens — the single biggest cost line. Above-the-fold
    // is enough for the vision rubric (design era, visible widgets, mobile layout); DOM +
    // network scanners already cover below-the-fold forms/widgets.
    const desktopScreenshot = await page.screenshot({ fullPage: false, type: 'png' }).catch(() => null);

    // Mobile pass: separate context; failure is non-fatal and never changes outcome
    let mobileScreenshot: Buffer | null = null;
    try {
      const mobileContext = await browser.newContext({
        viewport: MOBILE_VIEWPORT,
        userAgent: MOBILE_UA,
        isMobile: true,
        hasTouch: true,
      });
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(url, { waitUntil: 'domcontentloaded', timeout: MOBILE_TIMEOUT_MS });
      await mobilePage.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_TIMEOUT_MS }).catch(() => {});
      await dismissCookieWall(mobilePage);
      mobileScreenshot = await mobilePage.screenshot({ fullPage: false, type: 'png' });
      await mobileContext.close();
    } catch {
      mobileScreenshot = null;
    }

    return {
      outcome: 'ok', finalUrl, html, networkUrls: [...networkUrls],
      consoleErrors, desktopScreenshot, mobileScreenshot, cookieWallDetected,
    };
  } catch (err) {
    const { outcome, message } = classifyError(err);
    return {
      outcome: outcome === 'timeout' ? 'browser_error' : outcome, finalUrl: null, html: null,
      networkUrls: [...networkUrls], consoleErrors, desktopScreenshot: null,
      mobileScreenshot: null, cookieWallDetected: false, errorMessage: message,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
