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

export interface DetectedSig {
  id: string;
  name: string;
  category: string;
  evidence: { kind: 'network' | 'dom'; value: string };
}

export interface PremiumSignal {
  state: TriState;
  evidence?: { kind: 'dom' | 'network' | 'raw_fetch' | 'vision'; value: string };
  checkedBy: string[];
}

export interface PsiMetrics {
  mobileScore: number | null;
  lcp: number | null;
  tbt: number | null;
  tti: number | null;
  mobileFriendly: boolean | null;
  fetchedAt: string;
}

export interface VisionObservation {
  headline?: string;  // ≈3–7 words; absent on old vision_json rows (derive from text)
  text: string;
  confidence: number;
}

export interface VisionResult {
  strengths: VisionObservation[];
  opportunities: VisionObservation[];
  designEra: string;
  widgetVisibility: {
    whatsapp: 'yes' | 'no' | 'unsure';
    chat:     'yes' | 'no' | 'unsure';
    booking:  'yes' | 'no' | 'unsure';
  };
  mobileResponsive: 'yes' | 'no' | 'unsure';
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
  detectedSigs: DetectedSig[];
  psi: PsiMetrics | null;
  vision: VisionResult | null;
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
  // slice 0013: deliverability state from the validity gate (MX/SMTP probe cache).
  // 'unknown' = not yet probed or inconclusive; 'invalid' = placeholder/dead/bounced.
  email_validity: 'valid' | 'unknown' | 'invalid';
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
  outreachAnalysisJson: string | null;
  // slice 0045: composite LeadScore (email lane). Optional — only the "new" queue
  // (getOutreachLeads) populates these; other lanes leave them undefined.
  score?: number;
  grade?: 'A' | 'B' | 'C' | 'D';
}

export interface FollowUpLead extends OutreachLead {
  last_sent_at: string;
  send_count: number;
  // A tracking pixel was actually embedded (slice 0015). When false, opens were
  // never measurable — render "sin seguimiento", not a false "sin abrir".
  tracked: boolean;
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

// No-website lane (slice 0007): phone-only leads, WhatsApp cheap-site offer.
export function getNoSiteLeads(page: number, search?: string): Promise<{ rows: OutreachLead[]; total: number }> {
  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set('search', search);
  return request(`/outreach/no-site-leads?${params}`);
}

export function generateWaMessage(businessId: string): Promise<{ message: string }> {
  return request('/outreach/wa-generate', {
    method: 'POST',
    body: JSON.stringify({ businessId }),
  });
}

export function markWaContacted(businessId: string): Promise<{ ok: boolean }> {
  return request('/outreach/wa-contacted', {
    method: 'POST',
    body: JSON.stringify({ businessId }),
  });
}

export function getFollowUpLeads(page: number, days: number): Promise<{ rows: FollowUpLead[]; total: number }> {
  return request(`/outreach/follow-ups?page=${page}&days=${days}`);
}

export function getRepliedLeads(page: number): Promise<{ rows: RepliedLead[]; total: number }> {
  return request(`/outreach/replied?page=${page}`);
}

// Operator reclassification (slice 0014): flip a reply auto↔real.
export function setReplyType(businessId: string, replyType: 'auto' | 'real'): Promise<void> {
  return request('/outreach/reply-type', {
    method: 'POST',
    body: JSON.stringify({ businessId, replyType }),
  }).then(() => undefined);
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

export async function generateEmail(
  businessId: string,
  analysis?: WebsiteAnalysis,
): Promise<{ subject: string; body: string; verification?: { status: string; violations?: Array<{ claim: string; evidence: string }> } }> {
  // Server saves the draft atomically (including verification verdict) — no client-side saveDraft needed.
  const data = await request<{
    subject: string;
    body: string;
    topGap?: string | null;
    verification?: { status: string; violations?: Array<{ claim: string; evidence: string }> };
  }>('/outreach/generate', {
    method: 'POST',
    body: JSON.stringify({ businessId, analysis }),
  });
  return { subject: data.subject, body: data.body, verification: data.verification };
}

export function sendOutreachEmail(
  businessId: string,
  subject: string,
  body: string,
  options?: { override?: boolean },
): Promise<{ success: boolean; remaining: number; error?: string }> {
  const url = options?.override ? '/outreach/send?override=true' : '/outreach/send';
  return request(url, {
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

export function loadDraft(businessId: string): Promise<{ subject: string; body: string; isAiDraft: boolean; verificationJson?: string | null } | null> {
  return request<{ draft: { subject: string; body: string; isAiDraft: boolean; verificationJson?: string | null } | null }>(`/outreach/draft/${businessId}`)
    .then(d => d.draft);
}

// Buenos Aires is UTC-3 with no DST → a fixed offset is exact. The datetime-local
// picker yields a bare wall-clock string with no timezone; we treat it as BA local
// and convert to a TRUE-UTC instant explicitly, independent of the browser's tz.
const BA_OFFSET_MS = 3 * 60 * 60 * 1000;

// 'YYYY-MM-DDTHH:mm' (BA wall-clock) → true-UTC ISO string.
export function baLocalToUtcIso(local: string): string {
  const [datePart, timePart] = local.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  // BA wall-clock → UTC = BA + 3h.
  return new Date(Date.UTC(y, mo - 1, d, h, mi) + BA_OFFSET_MS).toISOString();
}

// Default picker value: BA wall-clock now + 1h, formatted 'YYYY-MM-DDTHH:mm'.
export function defaultScheduleLocal(): string {
  const ba = new Date(Date.now() - BA_OFFSET_MS + 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ba.getUTCFullYear()}-${p(ba.getUTCMonth() + 1)}-${p(ba.getUTCDate())}T${p(ba.getUTCHours())}:${p(ba.getUTCMinutes())}`;
}

// Format a true-UTC ISO as a compact BA-local label for display.
export function formatScheduledAt(utcIso: string): string {
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date(utcIso));
}

export interface ScheduledSend {
  id: string;
  business_id: string;
  business_name: string;
  scheduled_at: string; // true UTC ISO
  status: string;
  window_label: string | null;
}

// sendAt must be a TRUE-UTC ISO string. The caller computes it from the BA
// wall-clock picker (see Outreach.tsx baLocalToUtcIso) — never pass a raw
// datetime-local value, which has no timezone.
export function scheduleDraft(
  businessId: string,
  opts: { sendAt?: string; optimalWindow?: boolean },
): Promise<{ scheduled: ScheduledSend }> {
  return request('/outreach/schedule', {
    method: 'POST',
    body: JSON.stringify({ businessId, ...opts }),
  });
}

export function listScheduled(): Promise<ScheduledSend[]> {
  return request<{ scheduled: ScheduledSend[] }>('/outreach/scheduled').then(d => d.scheduled);
}

export function cancelScheduled(id: string): Promise<void> {
  return request(`/outreach/schedule/${id}`, { method: 'DELETE' }).then(() => undefined);
}

export function rescheduleScheduled(id: string, sendAt: string): Promise<void> {
  return request(`/outreach/schedule/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ sendAt }),
  }).then(() => undefined);
}

export function countryFlag(country: string | null): string {
  if (!country) return '';
  if (country === 'Argentina') return '🇦🇷';
  if (country.includes('United States')) return '🇺🇸';
  return '🌐';
}

// Full server-side scheduled_sends row — per-lead status endpoint returns this.
export interface ScheduledSendRow {
  id: string;
  business_id: string;
  scheduled_at: string;    // true UTC ISO
  status: string;          // scheduled|claimed|sent|failed|canceled|skipped|deferred|held|superseded
  claimed_at: string | null;
  attempt_count: number;
  last_error: string | null;
  business_type: string | null;
  window_label: string | null;
  disposition: string | null;
  created_at: string;
  updated_at: string;
  dry_run: number;         // 0|1
}

export interface SchedulerTickCounts {
  claimed: number; sent: number; deferred: number;
  held: number; errored: number; elapsedMs: number;
}

export interface SchedulerHealth {
  lastTickAt: string | null;
  ticksTotal: number;
  lastTickCounts: SchedulerTickCounts;
  intervalMs: number;
  nextTickEtaMs: number;
  paused: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
}

export interface ScheduledQueueStatus {
  health: SchedulerHealth;
  counts: {
    scheduled: number; sending: number; sent_today: number;
    deferred: number; held_now: number; superseded_today: number;
    canceled_today: number; failed_today: number;
  };
  next: ScheduledSend[];
}

export function getLeadScheduleStatus(businessId: string): Promise<ScheduledSendRow | null> {
  return request<{ row: ScheduledSendRow | null }>(`/outreach/schedule/status/${businessId}`)
    .then(d => d.row);
}

export function getScheduledQueueStatus(): Promise<ScheduledQueueStatus> {
  return request<ScheduledQueueStatus>('/scheduled/status');
}

export function pauseScheduler(reason?: string): Promise<{ paused: true; pausedAt: string }> {
  return request('/scheduled/pause', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function resumeScheduler(): Promise<{ paused: false }> {
  return request('/scheduled/resume', { method: 'POST' });
}

export function cancelScheduledById(id: string): Promise<{ canceled: true; id: string }> {
  return request(`/scheduled/cancel/${id}`, { method: 'POST' });
}

export function cancelScheduledByBusiness(businessId: string): Promise<{ canceledCount: number }> {
  return request(`/scheduled/cancel-business/${businessId}`, { method: 'POST' });
}

export function cancelAllPending(): Promise<{ canceledCount: number }> {
  return request('/scheduled/cancel-all-pending', { method: 'POST' });
}
