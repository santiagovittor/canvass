import { request } from 'undici';

export interface WebsiteAnalysis {
  loadedSuccessfully: boolean;
  hasViewportMeta: boolean;
  hasContactForm: boolean;
  hasOnlineBooking: boolean;
  hasWhatsappLink: boolean;
  hasSSL: boolean;
  pageTitle: string | null;
  metaDescription: string | null;
  hasMenuOrServices: boolean;
  finalUrl: string | null;
  error?: string;
  platform?: 'tiendanube' | 'wordpress' | 'shopify' | 'wix' | 'webflow' | 'mercadoshops' | 'squarespace' | 'custom';
  hasLiveChatWidget?: boolean;
  hasAnalytics?: boolean;
  hasTelLink?: boolean;
  hasStructuredData?: boolean;
  hasOpenGraph?: boolean;
  hasTestimonials?: boolean;
  hasVisibleEmail?: boolean;
  hasBlog?: boolean;
  hasFavicon?: boolean;
  hasNewsletterForm?: boolean;
  copyrightYear?: number | null;
  siteAppearsOutdated?: boolean;
  scriptCount?: number;
  htmlSizeKb?: number;
}

function failed(error: string): WebsiteAnalysis {
  return {
    loadedSuccessfully: false,
    hasViewportMeta: false,
    hasContactForm: false,
    hasOnlineBooking: false,
    hasWhatsappLink: false,
    hasSSL: false,
    pageTitle: null,
    metaDescription: null,
    hasMenuOrServices: false,
    finalUrl: null,
    error,
    platform: 'custom',
    hasLiveChatWidget: false,
    hasAnalytics: false,
    hasTelLink: false,
    hasStructuredData: false,
    hasOpenGraph: false,
    hasTestimonials: false,
    hasVisibleEmail: false,
    hasBlog: false,
    hasFavicon: false,
    hasNewsletterForm: false,
    copyrightYear: null,
    siteAppearsOutdated: false,
    scriptCount: 0,
    htmlSizeKb: 0,
  };
}

export function normalizeUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

export function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

// Signal signatures, shared with the premium analysis pass (premiumAnalyzer.ts)
// which runs them over rendered DOM + network request URLs.
export const VIEWPORT_RX = /name=["']viewport["']/i;
export const BOOKING_RX = /\b(reserva|turno|booking|book\s+now|cita|appointment|agendar|schedule)\b|calendly\.com|acuityscheduling|reservo\.com|booksy|setmore|simplybook/i;
export const WHATSAPP_RX = /wa\.me\/|wa\.link\/|whatsapp\.com\/send|api\.whatsapp\.com|whatsapp:\/\/|["']whatsapp["']/i;
export const MENU_RX = /\b(men[uú]|servicios|services|productos|products|carta|offerings)\b|agregar.al.carrito|add.to.cart/i;
export const CHAT_RX = /jivosite\.com|jivochat|tidio\.com|tidiochat|crisp\.chat|client\.crisp|intercomcdn\.com|widget\.intercom|tawk\.to|zopim\.com|zendesk.*widget|freshchat|livechatinc\.com|drift\.com|driftt|olark|livechat-widget|freshworks|manychat|fb-customerchat|xfbml\.customerchat\.js/i;
export const ANALYTICS_RX = /gtag\(|google-analytics\.com|analytics\.js|G-[A-Z0-9]{6,}|fbq\(|connect\.facebook\.net.*fbevents|hotjar\.com|mixpanel/i;
export const TEL_RX = /href=["']tel:/i;
export const STRUCTURED_DATA_RX = /application\/ld\+json/i;
export const OPEN_GRAPH_RX = /<meta[^>]+property=["']og:/i;
export const TESTIMONIALS_RX = /testimoni|reseñas\s+de\s+(clientes|pacientes|usuarios)|lo\s+que\s+dicen\s+nuestros|opiniones\s+de\s+(clientes|pacientes)/i;
export const VISIBLE_EMAIL_RX = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i;
export const BLOG_RX = /href=["'][^"']*\/blog|href=["'][^"']*\/noticias|href=["'][^"']*\/novedades|href=["'][^"']*\/articulos/i;
export const FAVICON_RX = /<link[^>]+rel=["'][^"']*(?:shortcut\s+)?icon/i;
export const NEWSLETTER_RX = /mailchimp|klaviyo|newsletter|suscri(?:b[ií]|p[ií])|subscribe/i;

// Returns the first <form> that looks like a contact form (email/phone inputs), or null.
export function findContactForm(html: string): string | null {
  const formRe = /<form[\s\S]*?<\/form>/gi;
  let m;
  while ((m = formRe.exec(html)) !== null) {
    const f = m[0].toLowerCase();
    if (
      /type=["']email["']/.test(f) ||
      /name=["']email["']/.test(f) ||
      /type=["']tel["']/.test(f) ||
      /name=["'](?:phone|telefono|tel)["']/.test(f) ||
      /placeholder=["'][^"']*(?:email|correo|tel[eé]fono|phone)/i.test(f)
    ) return m[0];
  }
  return null;
}

export async function analyzeWebsite(url: string): Promise<WebsiteAnalysis> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    let currentUrl = normalizeUrl(url);
    let finalUrl = currentUrl;
    let html = '';

    for (let hop = 0; hop <= 3; hop++) {
      const { statusCode, headers, body } = await request(currentUrl, {
        signal: controller.signal as AbortSignal,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; outreach-analyzer/1.0)' },
        bodyTimeout: 5000,
        headersTimeout: 5000,
      });

      if (statusCode >= 300 && statusCode < 400) {
        await body.text();
        if (hop === 3) break;
        const loc = Array.isArray(headers['location']) ? headers['location'][0] : headers['location'];
        if (!loc) break;
        currentUrl = new URL(loc, currentUrl).href;
        finalUrl = currentUrl;
        continue;
      }

      finalUrl = currentUrl;
      html = await body.text();
      break;
    }

    clearTimeout(timer);

    if (!html) return failed('no HTML received');

    const stripped = stripScriptsAndStyles(html);
    const lower = stripped.toLowerCase();     // visible text only
    const rawLower = html.toLowerCase();      // includes script/attr content

    const hasViewportMeta = VIEWPORT_RX.test(html);

    let hasContactForm = findContactForm(html) !== null;

    const hasOnlineBooking = BOOKING_RX.test(rawLower);
    let hasWhatsappLink = WHATSAPP_RX.test(rawLower);

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') || null : null;

    const metaMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) ??
      html.match(/<meta[^>]+content=["']([^"']*)[^>]+name=["']description["']/i);
    const metaDescription = metaMatch ? metaMatch[1].trim() || null : null;

    const hasMenuOrServices = MENU_RX.test(rawLower);

    const platform = (() => {
      if (/tiendanube\.com|nuvemshop\.com|mitiendanube\.com/i.test(html)) return 'tiendanube';
      if (/wp-content\/|wp-json\/|wordpress/i.test(html)) return 'wordpress';
      if (/cdn\.shopify\.com|myshopify\.com/i.test(html)) return 'shopify';
      if (/wix\.com\/|wixsite\.com|static\.wixstatic/i.test(html)) return 'wix';
      if (/webflow\.com|\.wf-|data-wf-/i.test(html)) return 'webflow';
      if (/mercadoshops|mlstatic\.com\/frontend\/shops/i.test(html)) return 'mercadoshops';
      if (/squarespace\.com|static\.squarespace/i.test(html)) return 'squarespace';
      return 'custom';
    })() as WebsiteAnalysis['platform'];

    const hasLiveChatWidget = CHAT_RX.test(rawLower);
    const hasAnalytics = ANALYTICS_RX.test(rawLower);
    const hasTelLink = TEL_RX.test(rawLower);
    const hasStructuredData = STRUCTURED_DATA_RX.test(html);
    const hasOpenGraph = OPEN_GRAPH_RX.test(html);
    const hasTestimonials = TESTIMONIALS_RX.test(lower);
    const hasVisibleEmail = VISIBLE_EMAIL_RX.test(lower);
    const hasBlog = BLOG_RX.test(lower);
    const hasFavicon = FAVICON_RX.test(html);
    const hasNewsletterForm = NEWSLETTER_RX.test(rawLower);

    const copyrightMatches = [...lower.matchAll(/©\s*(\d{4})|copyright\s*(\d{4})/gi)];
    const copyrightYear = copyrightMatches.length > 0
      ? Math.max(...copyrightMatches.map(m => parseInt(m[1] ?? m[2], 10)))
      : null;

    const siteAppearsOutdated = copyrightYear !== null && (new Date().getFullYear() - copyrightYear) >= 3;
    const scriptCount = (html.match(/<script\s[^>]*src=/gi) ?? []).length;
    const htmlSizeKb = Math.round(html.length / 1024);

    if (!hasWhatsappLink && !hasContactForm) {
      const origin = new URL(finalUrl).origin;
      const contactPaths = ['/contacto', '/contactanos', '/contacto-2', '/contact', '/contactus'];
      for (const path of contactPaths) {
        try {
          const secController = new AbortController();
          const secTimer = setTimeout(() => secController.abort(), 4000);
          const { statusCode, body: secBody } = await request(origin + path, {
            signal: secController.signal as AbortSignal,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; outreach-analyzer/1.0)' },
            bodyTimeout: 4000,
            headersTimeout: 4000,
          });
          clearTimeout(secTimer);
          if (statusCode === 200) {
            const secHtml = await secBody.text();
            const secRawLower = secHtml.toLowerCase();
            const secondaryHasWhatsapp = WHATSAPP_RX.test(secRawLower);
            const secondaryHasForm = findContactForm(secHtml) !== null;
            hasWhatsappLink = hasWhatsappLink || secondaryHasWhatsapp;
            hasContactForm = hasContactForm || secondaryHasForm;
            break;
          } else {
            await secBody.text().catch(() => {});
          }
        } catch {
          // silently continue
        }
      }
    }

    return {
      loadedSuccessfully: true,
      hasViewportMeta,
      hasContactForm,
      hasOnlineBooking,
      hasWhatsappLink,
      hasSSL: finalUrl.startsWith('https://'),
      pageTitle,
      metaDescription,
      hasMenuOrServices,
      finalUrl,
      platform,
      hasLiveChatWidget,
      hasAnalytics,
      hasTelLink,
      hasStructuredData,
      hasOpenGraph,
      hasTestimonials,
      hasVisibleEmail,
      hasBlog,
      hasFavicon,
      hasNewsletterForm,
      copyrightYear,
      siteAppearsOutdated,
      scriptCount,
      htmlSizeKb,
    };
  } catch (err) {
    clearTimeout(timer);
    return failed(err instanceof Error ? err.message : String(err));
  }
}
