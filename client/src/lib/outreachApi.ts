const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

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
}

export type TriState = 'PRESENT' | 'ABSENT_VERIFIED' | 'UNKNOWN';

export interface PremiumSignal {
  state: TriState;
  evidence?: { kind: 'dom' | 'network' | 'raw_fetch' | 'vision'; value: string };
  checkedBy: string[];
}

export interface PremiumAnalysis {
  id: string;
  businessId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  renderOutcome: string | null;
  finalUrl: string | null;
  signals: Record<string, PremiumSignal> | null;
  cookieWall: boolean;
  consoleErrors: string[];
  desktopScreenshotPath: string | null;
  mobileScreenshotPath: string | null;
  htmlPath: string | null;
  networkLogPath: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface OutreachLead {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  emailsJson: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  locCountry: string | null;
  locNeighbourhood: string | null;
  locCity: string | null;
  outreachStatus: string | null;
  valid_email: boolean;
  first_email: string | null;
  latitude: number | null;
  longitude: number | null;
  instagram: string | null;
  facebook: string | null;
  twitter: string | null;
  tiktok: string | null;
  linkedin: string | null;
  youtube: string | null;
  has_draft: boolean;
}

export interface FollowUpLead extends OutreachLead {
  last_sent_at: string;
  send_count: number;
  open_count: number;
  last_opened_at: string | null;
  reply_type: 'auto' | 'real' | 'unknown' | null;
}

export interface RepliedLead extends FollowUpLead {
  replied_at: string | null;
}

export interface OutreachStats {
  sent_today: number;
  remaining: number;
  total_contacted: number;
}

export interface OutreachLeadFilters {
  search?: string;
  country?: string;
  hasWebsite?: boolean;
  category?: string;
  validEmail?: boolean;
}

export function getOutreachLeads(page: number, filters: OutreachLeadFilters = {}): Promise<{ rows: OutreachLead[]; total: number }> {
  const params = new URLSearchParams({ page: String(page) });
  if (filters.search)                   params.set('search', filters.search);
  if (filters.country)                  params.set('country', filters.country);
  if (filters.hasWebsite !== undefined) params.set('hasWebsite', filters.hasWebsite ? '1' : '0');
  if (filters.category)                 params.set('category', filters.category);
  if (filters.validEmail !== undefined) params.set('validEmail', filters.validEmail ? '1' : '0');
  return request(`/outreach/leads?${params}`);
}

export function getOutreachCategories(): Promise<string[]> {
  return request('/outreach/categories');
}

export function getFollowUpLeads(page: number, days: number): Promise<{ rows: FollowUpLead[]; total: number }> {
  return request(`/outreach/follow-ups?page=${page}&days=${days}`);
}

export function getRepliedLeads(page: number): Promise<{ rows: RepliedLead[]; total: number }> {
  return request(`/outreach/replied?page=${page}`);
}

export function generateFollowUp(businessId: string): Promise<{ subject: string; body: string }> {
  return request('/outreach/generate-follow-up', {
    method: 'POST',
    body: JSON.stringify({ businessId }),
  });
}

export function skipFollowUp(businessId: string): Promise<void> {
  return request(`/outreach/follow-up/${businessId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'skip' }),
  }).then(() => undefined);
}

export async function analyzeWebsite(businessId: string): Promise<WebsiteAnalysis> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await request<WebsiteAnalysis>('/outreach/analyze', {
      method: 'POST',
      body: JSON.stringify({ businessId }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Returns 202 immediately — the render runs in a server-side queue (10–30s),
// progress arrives over SSE ('premium:progress'). No client timeout.
export function startPremiumAnalysis(businessId: string): Promise<{ id: string; deduped: boolean }> {
  return request('/outreach/premium-analyze', {
    method: 'POST',
    body: JSON.stringify({ businessId }),
  });
}

export function getPremiumAnalysis(businessId: string): Promise<PremiumAnalysis | null> {
  return request<{ analysis: PremiumAnalysis | null }>(`/outreach/premium/${businessId}`)
    .then(d => d.analysis);
}

export async function generateEmail(businessId: string, analysis?: WebsiteAnalysis): Promise<{ subject: string; body: string }> {
  const data = await request<{ subject: string; body: string; topGap?: string | null }>('/outreach/generate', {
    method: 'POST',
    body: JSON.stringify({ businessId, analysis }),
  });
  if (data.topGap !== undefined) {
    saveDraft(businessId, data.subject, data.body, true, data.topGap).catch(() => undefined);
  }
  return { subject: data.subject, body: data.body };
}

export function sendOutreachEmail(
  businessId: string,
  subject: string,
  body: string,
): Promise<{ success: boolean; remaining: number; error?: string }> {
  return request('/outreach/send', {
    method: 'POST',
    body: JSON.stringify({ businessId, subject, body }),
  });
}

export function getOutreachStats(): Promise<OutreachStats> {
  return request('/outreach/stats');
}

export function getSignatureHtml(): Promise<string | null> {
  return request<{ html: string | null }>('/outreach/signature').then(d => d.html ?? null);
}

export function saveDraft(businessId: string, subject: string, body: string, isAiDraft: boolean, topGap?: string | null): Promise<void> {
  const payload: Record<string, unknown> = { businessId, subject, body, isAiDraft };
  if (topGap !== undefined) payload.topGap = topGap;
  return request('/outreach/draft', {
    method: 'PUT',
    body: JSON.stringify(payload),
  }).then(() => undefined);
}

export function loadDraft(businessId: string): Promise<{ subject: string; body: string; isAiDraft: boolean } | null> {
  return request<{ draft: { subject: string; body: string; isAiDraft: boolean } | null }>(`/outreach/draft/${businessId}`)
    .then(d => d.draft);
}

export function countryFlag(country: string | null): string {
  if (!country) return '';
  if (country === 'Argentina') return '🇦🇷';
  if (country.includes('United States')) return '🇺🇸';
  return '🌐';
}
